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