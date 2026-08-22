import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
} from '@nestjs/common';
import { AccountService } from './account.service';
import type { CreateAccountDto, AccountItem } from './account.service';

@Controller('accounts')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  /**
   * 添加账号（即时 CAS 验证后入库）
   */
  @Post()
  async create(@Body() dto: CreateAccountDto): Promise<AccountItem> {
    return this.accountService.create(dto);
  }

  /**
   * 账号列表（含最近登录态）
   */
  @Get()
  async list(): Promise<AccountItem[]> {
    return this.accountService.list();
  }

  /**
   * 强制重新登录
   */
  @Post(':id/refresh')
  async refresh(@Param('id') id: string): Promise<AccountItem> {
    return this.accountService.refresh(id);
  }

  /**
   * 删除账号（有进行中任务时拒绝）
   */
  @Delete(':id')
  async remove(@Param('id') id: string): Promise<void> {
    await this.accountService.remove(id);
  }
}