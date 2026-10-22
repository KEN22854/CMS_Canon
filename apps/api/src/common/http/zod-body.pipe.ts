import { HttpStatus, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { API_ERROR_CODES, ApiError } from './api-error';

/** `@Body(new ZodBody(schema))` — the schema is also the DTO type, so validation and typing can't drift. */
export class ZodBody<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new ApiError(
      API_ERROR_CODES.VALIDATION_FAILED,
      'Request body is invalid',
      HttpStatus.BAD_REQUEST,
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
}
