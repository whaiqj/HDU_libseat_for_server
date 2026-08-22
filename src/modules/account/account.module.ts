import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from './entities/account.entity';
import { GrabTask } from '../grab-task/entities/grab-task.entity';
import { AccountService } from './account.service';
import { AccountController } from './account.controller';
import { SessionModule } from '../session/session.module';
import { validateCryptoOrThrow } from '../../common/utils/crypto.util';

@Module({
  imports: [
    TypeOrmModule.forFeature([Account, GrabTask]),
    SessionModule,
  ],
  controllers: [AccountController],
  providers: [AccountService],
  exports: [AccountService],
})
export class AccountModule implements OnModuleInit {
  private readonly logger = new Logger(AccountModule.name);

  onModuleInit(): void {
    // 启动自检：密钥不存在或格式错误时 fail-fast，终止启动
    try {
      validateCryptoOrThrow();
      this.logger.log('ACCOUNT_SECRET_KEY 自检通过');
    } catch (error) {
      this.logger.error(`ACCOUNT_SECRET_KEY 自检失败: ${(error as Error).message}`);
      throw error;
    }
  }
}
