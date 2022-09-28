import request from 'supertest';
import axios from 'axios';

import {
  PaymentService,
  PaymentStatus,
} from '../src/payment/service/payment.service';
import { PaymentProvider } from '../src/payment/entity/payment.entity.js';
import { UserEntity } from '../src/user/entity/user.entity';
import { assertEnv, sleep } from '../src/utils';

import * as testUtils from './utils';

// isolated here means that each test does not affect the later tests' expected
// results
export async function runIsolatedTests(appReference: () => any) {
  let app: any;
  let paymentService: PaymentService;
  let nftIds: number[];

  describe('clean e2e test cases (db is reset between each test)', () => {
    beforeEach(async () => {
      [app, paymentService] = appReference();
      nftIds = await testUtils.resetDb();
    });
    afterAll(async () => {
      await testUtils.resetDb(true);
    });

    it('NFTs that are not for sale yet cannot be added to the cart', async () => {
      const wallet1 = await testUtils.newWallet(app);
      await testUtils.withDbConn(async (db) => {
        await db.query(`
UPDATE nft
SET onsale_from = now() AT TIME ZONE 'UTC' + interval '1 hour'
WHERE id = ${nftIds[0]}
            `);
      });
      const resp = await request(app.getHttpServer())
        .post(`/users/cart/add/${nftIds[0]}`)
        .set('authorization', wallet1.login.bearer);
      expect(resp.statusCode).toEqual(400);
      expect(resp.body).toStrictEqual({
        statusCode: 400,
        message: 'This nft is not yet for sale',
      });

      const cart = await testUtils.cartList(app, wallet1);
      expect(cart).toStrictEqual({
        nfts: [],
      });
    });

    it('NFTs that are no longer for sale cannot be added to the cart', async () => {
      const wallet1 = await testUtils.newWallet(app);
      await testUtils.withDbConn(async (db) => {
        await db.query(`
UPDATE nft
SET onsale_until = now() AT TIME ZONE 'UTC' - interval '1 hour'
WHERE id = ${nftIds[0]}
            `);
      });
      const resp = await request(app.getHttpServer())
        .post(`/users/cart/add/${nftIds[0]}`)
        .set('authorization', wallet1.login.bearer);
      expect(resp.statusCode).toEqual(400);
      expect(resp.body).toStrictEqual({
        statusCode: 400,
        message: 'This nft is no longer for sale',
      });

      const cart = await testUtils.cartList(app, wallet1);
      expect(cart).toStrictEqual({
        nfts: [],
      });
    });
  });
}
