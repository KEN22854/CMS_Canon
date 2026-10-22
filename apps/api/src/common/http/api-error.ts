import { HttpException, HttpStatus } from '@nestjs/common';

export const API_ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL_ERROR',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES] | (string & {});

/** Wire format for every non-2xx response (see AllExceptionsFilter). */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export class ApiError extends HttpException {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    status: HttpStatus,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const notFound = (what: string) => new ApiError(API_ERROR_CODES.NOT_FOUND, `${what} not found`, HttpStatus.NOT_FOUND);
export const forbidden = (message: string, details?: unknown) => new ApiError(API_ERROR_CODES.FORBIDDEN, message, HttpStatus.FORBIDDEN, details);
export const conflict = (message: string, details?: unknown) => new ApiError(API_ERROR_CODES.CONFLICT, message, HttpStatus.CONFLICT, details);
export const badRequest = (code: ApiErrorCode, message: string, details?: unknown) => new ApiError(code, message, HttpStatus.BAD_REQUEST, details);
export const unauthenticated = (message = 'Authentication required', code: ApiErrorCode = API_ERROR_CODES.UNAUTHENTICATED) =>
  new ApiError(code, message, HttpStatus.UNAUTHORIZED);
export const quotaExceeded = (message: string, details?: unknown) => new ApiError('QUOTA_EXCEEDED', message, HttpStatus.PAYMENT_REQUIRED, details);
