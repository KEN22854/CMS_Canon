import type { Prisma } from '@canon/db';
import { Global, Injectable, Module } from '@nestjs/common';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';
import type { RequestPrincipal } from '../../common/auth/principal';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  tenantId: string;
  action: string;
  entityType: string;
  entityId: string;
  changes?: Prisma.InputJsonValue;
  aiInvolved?: boolean;
}

/**
 * Append-only audit trail (audit_logs is partitioned and canon_app cannot UPDATE/DELETE it).
 * Writes are best-effort-but-loud: an audit failure is logged at error level rather than failing
 * the user's action — compliance alerts on that log line.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuditService.name);
  }

  async record(entry: AuditEntry, actor: RequestPrincipal | undefined, req?: Request): Promise<void> {
    try {
      await this.prisma.forTenant({ tenantId: entry.tenantId, userId: actor?.userId }).auditLog.create({
        data: {
          tenantId: entry.tenantId,
          userId: actor?.userId ?? null,
          actorType: actor?.actorType ?? 'system',
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          changes: entry.changes ?? {},
          ipAddress: req?.ip ?? null,
          userAgent: req?.header('user-agent')?.slice(0, 512) ?? null,
          aiInvolved: entry.aiInvolved ?? actor?.actorType === 'agent',
        },
      });
    } catch (err) {
      this.logger.error({ err, action: entry.action, tenantId: entry.tenantId }, 'audit.write_failed');
    }
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
