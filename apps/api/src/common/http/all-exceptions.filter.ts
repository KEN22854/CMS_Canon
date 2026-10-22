import { AI_ERROR_CODES, AiGatewayError, type AiErrorCode } from '@canon/ai-gateway';
import { Catch, HttpException, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { API_ERROR_CODES, ApiError, type ApiErrorBody } from './api-error';

const AI_STATUS: Record<AiErrorCode, HttpStatus> = {
  [AI_ERROR_CODES.INVALID_REQUEST]: HttpStatus.BAD_REQUEST,
  [AI_ERROR_CODES.MODEL_NOT_ALLOWED]: HttpStatus.FORBIDDEN,
  [AI_ERROR_CODES.NO_CANDIDATE_MODEL]: HttpStatus.UNPROCESSABLE_ENTITY,
  [AI_ERROR_CODES.QUOTA_EXCEEDED]: HttpStatus.PAYMENT_REQUIRED,
  [AI_ERROR_CODES.RATE_LIMITED]: HttpStatus.TOO_MANY_REQUESTS,
  [AI_ERROR_CODES.BLOCKED_BY_GUARDRAIL]: HttpStatus.UNPROCESSABLE_ENTITY,
  [AI_ERROR_CODES.ALL_PROVIDERS_FAILED]: HttpStatus.SERVICE_UNAVAILABLE,
};

/** One error shape for the whole API; internals (stack, SQL, provider payloads) never reach clients. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const requestId = typeof req.id === 'string' ? req.id : undefined;

    const { status, body } = this.map(exception);
    body.error.requestId = requestId;

    if (status >= 500) this.logger.error({ err: exception, path: req.url }, body.error.message);
    else this.logger.debug({ code: body.error.code, path: req.url }, body.error.message);

    if (res.headersSent) {
      // SSE responses: the stream already started, so close it instead of writing a JSON body.
      res.end();
      return;
    }
    if (exception instanceof AiGatewayError && typeof exception.details.retryAfterSec === 'number') {
      res.setHeader('Retry-After', String(exception.details.retryAfterSec));
    }
    res.status(status).json(body);
  }

  private map(exception: unknown): { status: number; body: ApiErrorBody } {
    if (exception instanceof ApiError) {
      return { status: exception.getStatus(), body: { error: { code: exception.code, message: exception.message, details: exception.details } } };
    }
    if (exception instanceof AiGatewayError) {
      const details = exception.code === AI_ERROR_CODES.ALL_PROVIDERS_FAILED ? undefined : exception.details;
      return { status: AI_STATUS[exception.code], body: { error: { code: exception.code, message: exception.message, details } } };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return { status, body: { error: { code: httpCode(status), message: exception.message } } };
    }
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: { error: { code: API_ERROR_CODES.INTERNAL, message: 'Internal server error' } } };
  }
}

function httpCode(status: number): string {
  switch (status) {
    case 400:
      return API_ERROR_CODES.VALIDATION_FAILED;
    case 401:
      return API_ERROR_CODES.UNAUTHENTICATED;
    case 403:
      return API_ERROR_CODES.FORBIDDEN;
    case 404:
      return API_ERROR_CODES.NOT_FOUND;
    case 409:
      return API_ERROR_CODES.CONFLICT;
    case 429:
      return API_ERROR_CODES.RATE_LIMITED;
    default:
      return status >= 500 ? API_ERROR_CODES.INTERNAL : `HTTP_${status}`;
  }
}
