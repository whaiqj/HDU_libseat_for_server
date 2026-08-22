import { BookErrorCode } from '../errors/book-error-code.enum';

/**
 * bookSeats 接口返回结果
 */
export class BookSeatsResult {
  success: boolean;
  bookedSeatId?: string;
  errorCode?: BookErrorCode;
  /** 原始错误文案，用于日志 */
  errorMessage?: string;
}