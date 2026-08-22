import { TaskStatus } from '../entities/grab-task.entity';

/**
 * 抢座任务响应 DTO
 */
export class GrabTaskResponseDto {
  id: string;
  accountId: string;
  categoryId: string;
  contentId: string;
  beginTime: number;
  duration: number;
  seatPreference: string[];
  strictMode: boolean;
  triggerAt: number;
  status: TaskStatus;
  attempts: number;
  result: Record<string, any> | null;
  createdAt: Date;
  updatedAt: Date;
  /** 跨账号偏好重合软校验提示（可选，仅在有重合时返回） */
  warnings?: string[];
}