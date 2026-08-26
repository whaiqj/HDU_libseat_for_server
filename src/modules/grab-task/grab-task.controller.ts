import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  NotFoundException,
} from '@nestjs/common';
import { GrabTaskService } from './grab-task.service';
import { CreateGrabTaskDto } from './dto/create-grab-task.dto';
import { GrabTaskResponseDto } from './dto/grab-task-response.dto';

@Controller('grab-tasks')
export class GrabTaskController {
  constructor(private readonly grabTaskService: GrabTaskService) {}

  /**
   * 创建抢座任务
   */
  @Post()
  async create(@Body() dto: CreateGrabTaskDto): Promise<GrabTaskResponseDto> {
    const { task, warnings } = await this.grabTaskService.create(dto);
    return this.toResponse(task, warnings);
  }

  /**
   * 查询单个任务
   */
  @Get(':id')
  async findById(@Param('id') id: string): Promise<GrabTaskResponseDto> {
    const task = await this.grabTaskService.findById(id);
    if (!task) {
      throw new NotFoundException(`Task ${id} not found`);
    }
    return this.toResponse(task);
  }

  /**
   * 查询账号的所有任务
   */
  @Get()
  async findByAccountId(
    @Query('accountId') accountId: string,
  ): Promise<GrabTaskResponseDto[]> {
    const tasks = await this.grabTaskService.findByAccountId(accountId);
    return tasks.map((t) => this.toResponse(t));
  }

  /**
   * 取消任务
   */
  @Delete(':id')
  async cancel(@Param('id') id: string): Promise<void> {
    await this.grabTaskService.cancel(id);
  }

  private toResponse(task: any, warnings?: string[]): GrabTaskResponseDto {
    const dto: GrabTaskResponseDto = {
      id: task.id,
      accountId: task.accountId,
      categoryId: task.categoryId,
      contentId: task.contentId,
      roomId: task.roomId ?? null,
      roomName: task.roomName ?? null,
      beginTime: task.beginTime,
      duration: task.duration,
      seatPreference: task.seatPreference ?? [],
      strictMode: task.strictMode ?? false,
      triggerAt: task.triggerAt,
      status: task.status,
      attempts: task.attempts,
      result: task.result,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
    if (warnings && warnings.length > 0) {
      dto.warnings = warnings;
    }
    return dto;
  }
}