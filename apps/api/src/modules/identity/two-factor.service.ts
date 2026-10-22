import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { FieldEncryption } from '../../common/crypto/encryption';
import { verifyPassword } from '../../common/crypto/password';
import { sha256 } from '../../common/crypto/tokens';
import { base32Encode, generateTotpSecret, otpauthUrl, verifyTotp } from '../../common/crypto/totp';
import { badRequest, conflict, unauthenticated } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS } from '../../infrastructure/redis/redis.module';

const ISSUER = 'Canon CMS';
const BACKUP_CODES = 10;

@Injectable()
export class TwoFactorService {
  private readonly crypto: FieldEncryption;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.crypto = new FieldEncryption(config.ENCRYPTION_KEY);
  }

  /** Step 1: store an encrypted, not-yet-active secret. Re-running replaces an unconfirmed one. */
  async beginEnrollment(userId: string, password: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.twoFactorEnabled) throw conflict('Two-factor authentication is already enabled');
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, password))) throw unauthenticated('Password is incorrect', 'INVALID_CREDENTIALS');
    const secret = generateTotpSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorSecret: this.crypto.encrypt(secret) } });
    return { secret, otpauthUrl: otpauthUrl(secret, user.email, ISSUER) };
  }

  /** Step 2: prove possession of the authenticator; only then is 2FA enforced at login. */
  async confirmEnrollment(userId: string, code: string): Promise<{ backupCodes: string[] }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.twoFactorEnabled) throw conflict('Two-factor authentication is already enabled');
    if (!user.twoFactorSecret) throw badRequest('TWO_FACTOR_NOT_STARTED', 'Start enrollment first (POST /v1/auth/2fa/enable)');
    if (!(await this.checkTotp(userId, this.crypto.decrypt(user.twoFactorSecret), code))) throw invalidCode();
    const { codes, hashes } = generateBackupCodes();
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true, twoFactorBackupCodes: hashes } });
    return { backupCodes: codes };
  }

  async disable(userId: string, password: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFactorEnabled) return;
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, password))) throw unauthenticated('Password is incorrect', 'INVALID_CREDENTIALS');
    if (!(await this.verify(userId, code))) throw invalidCode();
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: [] } });
  }

  async regenerateBackupCodes(userId: string, code: string): Promise<{ backupCodes: string[] }> {
    if (!(await this.verify(userId, code, { allowBackupCode: false }))) throw invalidCode();
    const { codes, hashes } = generateBackupCodes();
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorBackupCodes: hashes } });
    return { backupCodes: codes };
  }

  /** TOTP or (once) a backup code. Used for the login challenge and for sensitive actions. */
  async verify(userId: string, code: string, opts: { allowBackupCode?: boolean } = {}): Promise<boolean> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFactorEnabled || !user.twoFactorSecret) return false;
    const normalized = code.replace(/\s/g, '');
    if (/^\d{6}$/.test(normalized)) return this.checkTotp(userId, this.crypto.decrypt(user.twoFactorSecret), normalized);
    if (opts.allowBackupCode === false) return false;

    const hash = sha256(normalized.toLowerCase());
    if (!user.twoFactorBackupCodes.includes(hash)) return false;
    // Conditional update on the array content makes consumption single-use under concurrency.
    const res = await this.prisma.user.updateMany({
      where: { id: userId, twoFactorBackupCodes: { has: hash } },
      data: { twoFactorBackupCodes: user.twoFactorBackupCodes.filter((h) => h !== hash) },
    });
    return res.count === 1;
  }

  /** Each TOTP step may be used once — an intercepted code cannot be replayed within its 90 s window. */
  private async checkTotp(userId: string, secret: string, code: string): Promise<boolean> {
    const counter = verifyTotp(secret, code);
    if (counter === null) return false;
    try {
      const fresh = await this.redis.set(`auth:totp:${userId}:${counter}`, '1', 'EX', 120, 'NX');
      return fresh === 'OK';
    } catch {
      return true; // without Redis we lose replay protection, not the second factor itself
    }
  }
}

function generateBackupCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: BACKUP_CODES }, () => {
    const raw = base32Encode(randomBytes(5)).toLowerCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  });
  return { codes, hashes: codes.map((c) => sha256(c)) };
}

function invalidCode() {
  return unauthenticated('Invalid verification code', 'INVALID_2FA_CODE');
}

