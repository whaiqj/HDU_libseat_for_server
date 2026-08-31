import { IsString, IsNumber, IsArray, IsBoolean, IsOptional, Min } from 'class-validator';

/**
 * 创建抢座任务请求 DTO
 */
export class CreateGrabTaskDto {
  @IsString()
  accountId: string;

  /** 空间分类 ID（可选，后端默认填充自习室分类 591） */
  @IsString()
  @IsOptional()
  categoryId?: string;

  /** 空间内容 ID（可选，后端默认填充自习室分类 3） */
  @IsString()
  @IsOptional()
  contentId?: string;

  /** 指定房间 ID（可选，对应第三方 info.id，如 二楼东=1557）。多房间分类下锁定房间，座位号才能唯一解析为 seatId */
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