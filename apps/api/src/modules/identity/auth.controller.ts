import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public, RateLimit } from '../../common/auth/decorators';
import { Principal, type RequestPrincipal } from '../../common/auth/principal';
import { forbidden, notFound, unauthenticated } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { assertTrustedOrigin, clearRefreshCookie, isNativeClient, readRefreshToken, setRefreshCookie } from './auth-cookies';
import {
  changePasswordBody,
  codeBody,
  disable2faBody,
  emailBody,
  loginBody,
  mfaLoginBody,
  passwordBody,
  refreshBody,
  registerBody,
  resetPasswordBody,
  switchTenantBody,
  tokenBody,
  type LoginBody,
  type RegisterBody,
} from './auth.dto';
import { AuthService, type AuthSuccess, type MfaChallenge } from './auth.service';
import { SessionService, type ClientMeta } from './session.service';
import { TwoFactorService } from './two-factor.service';

// Credential endpoints share an IP budget so attackers cannot rotate between them.
const AUTH_IP_LIMIT = { bucket: 'auth', limit: 20, windowSec: 60, by: 'ip' } as const;
const MAIL_IP_LIMIT = { bucket: 'auth-mail', limit: 5, windowSec: 600, by: 'ip' } as const;

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly twoFactor: TwoFactorService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(202)
  @RateLimit(MAIL_IP_LIMIT)
  @ApiOperation({ summary: 'Sign up. Returns 202 check_email, or a session when an invite token proves the email' })
  async register(@Body(new ZodBody(registerBody)) body: RegisterBody, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.register(body, meta(req));
    if (result.kind === 'pending') return { status: result.status };
    res.status(201);
    return this.respond(result, req, res);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(200)
  @RateLimit(AUTH_IP_LIMIT)
  async verifyEmail(@Body(new ZodBody(tokenBody)) body: { token: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(await this.auth.verifyEmail(body.token, meta(req)), req, res);
  }

  @Public()
  @Post('verify-email/resend')
  @HttpCode(202)
  @RateLimit(MAIL_IP_LIMIT)
  async resend(@Body(new ZodBody(emailBody)) body: { email: string }) {
    await this.auth.resendVerification(body.email);
    return { status: 'check_email' };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @RateLimit(AUTH_IP_LIMIT)
  @ApiOperation({ summary: 'Password login. Returns a session, or { mfaRequired, mfaToken } when 2FA is on' })
  async login(@Body(new ZodBody(loginBody)) body: LoginBody, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(await this.auth.login(body, meta(req)), req, res);
  }

  @Public()
  @Post('2fa/login')
  @HttpCode(200)
  @RateLimit(AUTH_IP_LIMIT)
  @ApiOperation({ summary: 'Second step of login with a TOTP or backup code' })
  async mfaLogin(@Body(new ZodBody(mfaLoginBody)) body: { mfaToken: string; code: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(await this.auth.completeMfa(body.mfaToken, body.code, meta(req)), req, res);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth-refresh', limit: 60, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Rotate the refresh token (cookie or body) and get a new access token' })
  async refresh(@Body(new ZodBody(refreshBody)) body: { refreshToken?: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = readRefreshToken(req, body.refreshToken);
    assertTrustedOrigin(req, this.config, !body.refreshToken);
    if (!token) throw unauthenticated('No refresh token');
    try {
      return this.respond(await this.auth.refresh(token, meta(req)), req, res);
    } catch (err) {
      clearRefreshCookie(res, this.config);
      throw err;
    }
  }

  @Post('switch-tenant')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Re-issue tokens for another tenant the user belongs to' })
  async switchTenant(@Body(new ZodBody(switchTenantBody)) body: { tenantId: string; refreshToken?: string }, @Principal() p: RequestPrincipal, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = readRefreshToken(req, body.refreshToken);
    assertTrustedOrigin(req, this.config, !body.refreshToken);
    if (!token) throw unauthenticated('No refresh token');
    return this.respond(await this.auth.switchTenant(p, token, body.tenantId, meta(req)), req, res);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body(new ZodBody(refreshBody)) body: { refreshToken?: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    assertTrustedOrigin(req, this.config, !body.refreshToken);
    await this.auth.logout(readRefreshToken(req, body.refreshToken), req.principal);
    clearRefreshCookie(res, this.config);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  @RateLimit(MAIL_IP_LIMIT)
  async forgot(@Body(new ZodBody(emailBody)) body: { email: string }) {
    await this.auth.forgotPassword(body.email);
    return { status: 'check_email' };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(204)
  @RateLimit(AUTH_IP_LIMIT)
  async reset(@Body(new ZodBody(resetPasswordBody)) body: { token: string; password: string }): Promise<void> {
    await this.auth.resetPassword(body.token, body.password);
  }

  @Post('change-password')
  @HttpCode(204)
  @ApiBearerAuth()
  @RateLimit({ bucket: 'auth-change-password', limit: 5, windowSec: 600, by: 'principal' })
  async changePassword(@Body(new ZodBody(changePasswordBody)) body: { currentPassword: string; newPassword: string }, @Principal() p: RequestPrincipal): Promise<void> {
    await this.auth.changePassword(p, body.currentPassword, body.newPassword);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current principal, tenants and packed CASL rules for UI gating' })
  me(@Principal() p: RequestPrincipal) {
    return this.auth.me(p);
  }

  @Get('sessions')
  @ApiBearerAuth()
  sessionsList(@Principal() p: RequestPrincipal) {
    return this.sessions.listActive(userOf(p), p.sessionId);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(204)
  @ApiBearerAuth()
  async revokeSession(@Param('sessionId') sessionId: string, @Principal() p: RequestPrincipal): Promise<void> {
    if (!(await this.sessions.revokeOwn(userOf(p), sessionId))) throw notFound('Session');
  }

  @Post('2fa/enable')
  @HttpCode(200)
  @ApiBearerAuth()
  @RateLimit({ bucket: 'auth-2fa', limit: 10, windowSec: 600, by: 'principal' })
  @ApiOperation({ summary: 'Start TOTP enrollment (requires password); returns the secret and otpauth URL' })
  enable2fa(@Body(new ZodBody(passwordBody)) body: { password: string }, @Principal() p: RequestPrincipal) {
    return this.twoFactor.beginEnrollment(userOf(p), body.password);
  }

  @Post('2fa/verify')
  @HttpCode(200)
  @ApiBearerAuth()
  @RateLimit({ bucket: 'auth-2fa', limit: 10, windowSec: 600, by: 'principal' })
  @ApiOperation({ summary: 'Confirm enrollment with a code; returns one-time backup codes (shown once)' })
  verify2fa(@Body(new ZodBody(codeBody)) body: { code: string }, @Principal() p: RequestPrincipal) {
    return this.twoFactor.confirmEnrollment(userOf(p), body.code);
  }

  @Post('2fa/disable')
  @HttpCode(204)
  @ApiBearerAuth()
  @RateLimit({ bucket: 'auth-2fa', limit: 10, windowSec: 600, by: 'principal' })
  async disable2fa(@Body(new ZodBody(disable2faBody)) body: { password: string; code: string }, @Principal() p: RequestPrincipal): Promise<void> {
    await this.twoFactor.disable(userOf(p), body.password, body.code);
  }

  @Post('2fa/backup-codes')
  @HttpCode(200)
  @ApiBearerAuth()
  @RateLimit({ bucket: 'auth-2fa', limit: 10, windowSec: 600, by: 'principal' })
  regenerateBackupCodes(@Body(new ZodBody(codeBody)) body: { code: string }, @Principal() p: RequestPrincipal) {
    return this.twoFactor.regenerateBackupCodes(userOf(p), body.code);
  }

  private respond(result: AuthSuccess | MfaChallenge, req: Request, res: Response) {
    if (result.kind === 'mfa') return { mfaRequired: true, mfaToken: result.mfaToken };
    setRefreshCookie(res, this.config, result.session.refreshToken, result.session.expiresAt);
    return {
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      expiresIn: result.expiresIn,
      user: result.user,
      tenant: result.tenant,
      ...(isNativeClient(req) ? { refreshToken: result.session.refreshToken, refreshExpiresAt: result.session.expiresAt } : {}),
    };
  }
}

function meta(req: Request): ClientMeta {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}

function userOf(p: RequestPrincipal): string {
  if (!p.userId) throw forbidden('Not available for API keys');
  return p.userId;
}
