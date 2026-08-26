import { IsString, IsNumber, IsArray, IsBoolean, IsOptional, Min } from 'class-validator';

/**
 * 创建抢座任务请求 DTO
 */
export class CreateGrabTaskDto {
  @IsString()
  accountId: string;

  @IsString()
  categoryId: string;

  @IsString()
  contentId: string;

  /** 指定房间 ID（可选）。多房间分类下锁定房间，座位号才能唯一解析为 seatId */
  @IsString()
  @IsOptional()
  roomId?: string;

  /** 指定房间名称（可选，展示用） */
  @IsString()
  @IsOptional()
  roomName?: string;

  @IsNumber()
  beginTime: number;

  @IsNumber()
  @Min(1)
  duration: number;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  seatPreference?: string[];

  @IsBoolean()
  @IsOptional()
  strictMode?: boolean;

  @IsNumber()
  triggerAt: number;
}