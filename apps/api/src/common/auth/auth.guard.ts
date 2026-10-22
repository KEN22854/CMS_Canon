import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { API_ERROR_CODES, ApiError } from '../http/api-error';
import { AccessTokenService } from './access-token.service';
import { API_KEY_PREFIX, ApiKeyAuthenticator } from './api-key.authenticator';
import { IS_PUBLIC } from './decorators';

/**
 * Global guard: every route is authenticated unless marked @Public().
 * Credentials: `Authorization: Bearer <jwt|ck_…>` or `x-api-key: ck_…`.
 * The tenant comes from the credential itself (JWT `tid` / key's tenant) — never from the request,
 * so a caller cannot point a valid token at another tenant.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
    private readonly apiKeys: ApiKeyAuthenticator,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const credential = extractCredential(req);
    if (!credential) {
      throw new ApiError(API_ERROR_CODES.UNAUTHENTICATED, 'Authentication required', HttpStatus.UNAUTHORIZED);
    }

    if (credential.startsWith(API_KEY_PREFIX)) {
      req.principal = await this.apiKeys.authenticate(credential);
      return true;
    }

    const claims = await this.tokens.verifyAccess(credential);
    req.principal = {
      actorType: 'user',
      userId: claims.sub,
      sessionId: claims.sid,
      tenantId: claims.tid,
      memberRole: claims.trl,
      systemRole: claims.srl,
    };
    return true;
  }
}

function extractCredential(req: Request): string | undefined {
  const header = req.header('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || undefined;
  const apiKey = req.header('x-api-key');
  return apiKey?.trim() || undefined;
}
