import { Test, TestingModule } from '@nestjs/testing';
import { Logger, HttpException, HttpStatus } from '@nestjs/common';
import { NftController } from './nft.controller';
import { DbMockModule } from '../../db_mock.module';
import { NftServiceMock } from '../service/nft_mock.service';
import { PaginationParams } from '../params';

describe('NftController', () => {
  let controller: NftController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [DbMockModule],
      controllers: [NftController],
      providers: [
        {
          provide: 'NftService',
          useClass: NftServiceMock,
        },
      ],
    }).compile();

    controller = module.get<NftController>(NftController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  const expHttpStatusTests = [
    {
      name: 'bad page number (< 1)',
      params: { ...new PaginationParams(), page: 0 },
      expStatusCode: 400,
    },
    {
      name: 'bad page number (< 1), part 2',
      params: { ...new PaginationParams(), page: -1 },
      expStatusCode: 400,
    },
    {
      name: 'bad page size (< 1)',
      params: { ...new PaginationParams(), pageSize: 0 },
      expStatusCode: 400,
    },
    {
      name: 'empty order direction',
      params: { ...new PaginationParams(), orderDirection: '' },
      expStatusCode: 400,
    },
    {
      name: 'empty order by',
      params: { ...new PaginationParams(), orderBy: '' },
      expStatusCode: 400,
    },
    {
      name: 'all default values is OK (note: expecting 500, due to mock throwing an err after params checks)',
      params: new PaginationParams(),
      expStatusCode: 500,
    },
  ];

  for (const { name, params, expStatusCode } of expHttpStatusTests) {
    it(`${name}: should return ${expStatusCode} for .get(${JSON.stringify(
      params,
    )})`, async () => {
      await expectErrWithHttpStatus(expStatusCode, () =>
        controller.getFiltered(params),
      );
    });
  }
});

async function expectErrWithHttpStatus(
  expStatusCode: number,
  f: () => Promise<any>,
): Promise<void> {
  try {
    await f();
  } catch (err: any) {
    //Logger.error(err);
    expect(err instanceof HttpException).toBe(true);

    const gotStatusCode = err.getStatus();
    expect(gotStatusCode).toEqual(expStatusCode);
    return;
  }
  expect('expected HttpException').toBe('got no error');
}
