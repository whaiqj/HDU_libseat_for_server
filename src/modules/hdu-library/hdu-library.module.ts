import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { HduLibraryClientService } from './hdu-library-client.service';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [
    HttpModule.register({
      timeout: 15_000, // 15 秒兜底超时（实际每次请求会用自适应值覆盖）
      maxRedirects: 0, // 禁止自动跳转（登录失效会 302 跳登录页，直接当错误处理）
    }),
    SessionModule,
  ],
  providers: [HduLibraryClientService],
  exports: [HduLibraryClientService],
})
export class HduLibraryModule {}