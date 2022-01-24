import {
  Logger,
  HttpException,
  HttpStatus,
  Injectable,
  Inject,
} from '@nestjs/common';
import { PG_CONNECTION } from 'src/constants';
import { DbPool } from 'src/db.module';
import { STMResultStatus, StateTransitionMachine, Actor } from 'roles_stm';
import { User } from 'src/user/entities/user.entity';
import { NftEntity, NftUpdate } from '../entities/nft.entity';
import { NftFilterParams, parseStringArray } from '../params';
import { RoleService } from 'src/role/role.service';
import { S3Service } from './s3.service';
import { Lock } from 'async-await-mutex-lock';
import { QueryParams } from 'src/types';
import {
  convertToSnakeCase,
  prepareFilterClause,
  prepareNftFilterClause,
} from 'src/utils';
const fs = require('fs');

@Injectable()
export class NftService {
  stm: StateTransitionMachine;
  nftLock: Lock<number>;
  CONTENT_TYPE = 'content_uri';

  constructor(
    @Inject(S3Service) private s3Service: S3Service,
    @Inject(PG_CONNECTION) private db: DbPool,
    private readonly roleService: RoleService,
  ) {
    const stmConfigFile = './config/stm_example.yaml';
    this.stm = new StateTransitionMachine(stmConfigFile);
    this.nftLock = new Lock<number>();
    fs.watch(stmConfigFile, (event: any, filename: any) => {
      if (event !== 'change') {
        return;
      }
      try {
        Logger.log('State transition machine config changed, reloading..');
        this.stm = new StateTransitionMachine(filename);
        Logger.log('State transition machine config reloaded');
      } catch (err: any) {
        Logger.warn(
          `State transition machine config reload failed, err: ${err}`,
        );
      }
    });
  }

  async findAll(params: NftFilterParams): Promise<NftEntity[]> {
    const dbTx = await this.db.connect();
    try {
      await dbTx.query('BEGIN');
      const nftIds = await dbTx.query(
        `
SELECT nft.id AS nft_id
FROM nft
WHERE ($1::TEXT[] IS NULL OR state = ANY($1::TEXT[]))
OFFSET ${params.pageOffset}
LIMIT  ${params.pageSize}
ORDER BY ${params.orderBy} ${params.orderDirection}
      `,
        [params.nftStates],
      );

      return await this.findByIds(
        nftIds.rows.map((row: any) => row['nft_id']),
        dbTx,
      );
    } finally {
      dbTx.release();
    }
  }

  /*
  async findAll({
    range,
    sort,
    filter,
  }: QueryParams): Promise<{ data: NftEntity[][]; count: any }> {
    const { query: whereClause, params } = prepareFilterClause(filter);
    const limitClause =
      range.length === 2
        ? `LIMIT ${range[1] - range[0]} OFFSET ${range[0]}`
        : undefined;
    const sortField = sort && sort[0] ? convertToSnakeCase(sort[0]) : 'id';
    const sortDirection = sort && sort[1] ? sort[1] : 'ASC';

    const countResult = await this.db.query(
      getSelectCountStatement(whereClause),
      [sortField, ...params],
    );

    const result = await this.db.query<NftEntity[]>(
      getSelectStatement(whereClause, limitClause, sortField, sortDirection),
      params,
    );

    return { data: result.rows, count: countResult?.rows[0]?.count ?? 0 };
  }
  */

  async findByIds(ids: number[], dbTx?: any): Promise<NftEntity[]> {
    const dbconn = dbTx || this.db;
    const qryRes = await dbconn.query(
      `
WITH attr AS (
  SELECT
    nft_id,
    ARRAY_AGG(ARRAY[name, value]) AS attributes
  FROM nft_attribute
  WHERE nft_id = ANY($1)
  GROUP BY nft_id
)
SELECT
  nft.id AS nft_id,
  nft.created_by,
  nft.created_at,
  nft.updated_at,
  nft.state,
  COALESCE(attr.attributes, ARRAY[]::TEXT[][]) AS attributes
FROM nft
LEFT JOIN attr
  ON nft.id = attr.nft_id
WHERE id = ANY($1)
ORDER BY id
    `,
      [ids],
    );
    if (qryRes.rowCount === 0) {
      return undefined;
    }
    return qryRes.rows.map((row: any) => {
      const nft = <NftEntity>{
        id: row['nft_id'],
        createdBy: row['created_by'],
        createdAt: Math.floor(row['created_at'].getTime() / 1000),
        updatedAt: Math.floor(row['updated_at'].getTime() / 1000),
        state: row['state'],
        attributes: {},
      };
      for (const [name, value] of row['attributes']) {
        nft.attributes[name] = JSON.parse(value);
      }
      return nft;
    });
  }

  async getNft(user: User, nftId: number) {
    const nfts = await this.findByIds([nftId]);

    if (nfts.length === 0) {
      throw new HttpException(`nft does not exist`, HttpStatus.BAD_REQUEST);
    }
    const nft = nfts[0];
    const actor = await this.getActorForNft(user, nft);

    return {
      ...nft,
      allowedActions: this.stm.getAllowedActions(actor, nft),
    };
  }

  async getActorForNft(user: User, nft: NftEntity): Promise<Actor> {
    const roles = await this.roleService.getLabels(user.roles);
    if (nft.createdBy === user.id) {
      roles.push('creator');
    }
    return new Actor(user.id, roles);
  }

  async apply(
    user: User,
    nftId: number,
    nftUpdates: NftUpdate[],
    lockNft = true,
  ): Promise<NftEntity> {
    if (lockNft) {
      await this.nftLock.acquire(nftId);
    }
    try {
      let nfts = await this.findByIds([nftId]);
      if (typeof nfts === 'undefined') {
        nfts = [await this.#createNft(user)];
      }
      const nft = nfts[0];
      const actor = await this.getActorForNft(user, nft);

      for (let nftUpdate of nftUpdates) {
        // Check if attribute is of type content in order to upload to ipfs
        if (this.stm.getAttrType(nftUpdate.attribute) === 'contentUri') {
          nftUpdate = await this.#uploadContent(
            user,
            nft.id,
            nftUpdate.attribute,
            nftUpdate.value,
          );
        }

        const stmRes = this.stm.tryAttributeApply(
          actor,
          nft,
          nftUpdate.attribute,
          nftUpdate.value,
        );

        if (stmRes.status != STMResultStatus.OK) {
          switch (stmRes.status) {
            case STMResultStatus.NOT_ALLOWED:
              throw new HttpException(
                stmRes.message || '',
                HttpStatus.UNAUTHORIZED,
              );
            default:
              throw new HttpException(
                stmRes.message || '',
                HttpStatus.INTERNAL_SERVER_ERROR,
              );
          }
        }
      }

      await this.#updateNft(user, nft);
      return await this.getNft(user, nft.id);
    } catch (err: any) {
      throw err;
    } finally {
      if (lockNft) {
        this.nftLock.release(nftId);
      }
    }
  }

  async #uploadContent(
    user: User,
    nftId: number,
    attribute: string,
    picture: any,
  ): Promise<NftUpdate> {
    // verify first that we are allowed to change the content, before uploading
    // to S3 (and potentially overwriting an earlier set content)
    const nft = await this.getNft(user, nftId);
    if (typeof nft === 'undefined') {
      throw new HttpException(`nft does not exist`, HttpStatus.BAD_REQUEST);
    }
    if (!nft.allowedActions.hasOwnProperty(attribute)) {
      throw new HttpException(
        `attribute '${attribute}' is not allowed to be set by you for nft with state '${nft.state}'`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (nft.allowedActions[attribute] != this.CONTENT_TYPE) {
      throw new HttpException(
        `attribute '${attribute}' is not of type ${this.CONTENT_TYPE}`,
        HttpStatus.UNAUTHORIZED,
      );
    }

    const fileName = `nft_${nftId}_${attribute}`;
    // we'll simply store the uri as a pointer to the image in our own db
    const contentUri = await this.s3Service.uploadFile(picture, fileName);

    return <NftUpdate>{
      attribute: attribute,
      value: JSON.stringify(contentUri),
    };
  }

  async #createNft(creator: User): Promise<NftEntity> {
    try {
      const qryRes = await this.db.query(
        `
INSERT INTO nft (
  created_by, state
)
VALUES ($1, 'creation')
RETURNING id
    `,
        [creator.id],
      );
      return await this.getNft(creator, qryRes.rows[0].id);
    } catch (err: any) {
      Logger.error(`Unable to create new nft, err: ${err}`);
      throw new HttpException(
        'Unable to create new nft',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async #updateNft(setBy: User, nft: NftEntity) {
    const attrNames = Object.keys(nft.attributes);
    const attrValues = attrNames.map((name: string) =>
      JSON.stringify(nft.attributes[name]),
    );

    const dbTx = await this.db.connect();
    try {
      await dbTx.query(`BEGIN`);
      dbTx.query(
        `
UPDATE nft
SET state = $2
WHERE id = $1
      `,
        [nft.id, nft.state],
      );
      await dbTx.query(
        `
INSERT INTO nft_attribute AS TARGET (
  nft_id, set_by, name, value
)
SELECT $1, $2, attr.name, attr.value
FROM UNNEST($3::text[], $4::text[]) attr(name, value)
ON CONFLICT ON CONSTRAINT nft_attribute_pkey DO UPDATE
SET
  value = EXCLUDED.value,
  set_at = now() AT TIME ZONE 'UTC'
WHERE TARGET.value != EXCLUDED.value
      `,
        [nft.id, setBy.id, attrNames, attrValues],
      );
      await dbTx.query(`COMMIT`);
    } catch (err: any) {
      Logger.error(`failed to update nft (id=${nft.id}), err: ${err}`);
      await dbTx.query(`ROLLBACK`);
      throw err;
    } finally {
      dbTx.release();
    }
  }
}
