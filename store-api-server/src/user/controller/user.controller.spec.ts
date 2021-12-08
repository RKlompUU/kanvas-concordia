import { Test, TestingModule } from '@nestjs/testing';
import { UserController } from './user.controller';
import { DbMockModule } from '../../db_mock.module';
import { UserService } from '../service/user.service';
import { NftService } from '../../nft/service/nft.service';
import { S3Service } from '../../s3.service';

describe('UserController', () => {
  let controller: UserController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [DbMockModule],
      controllers: [UserController],
      providers: [UserService, NftService, S3Service],
    }).compile();

    controller = module.get<UserController>(UserController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
