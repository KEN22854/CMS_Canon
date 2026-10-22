import { Controller, Get, Header, HttpStatus, Inject, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/auth/decorators';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { MetricsService } from '../../infrastructure/metrics/metrics.service';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS } from '../../infrastructure/redis/redis.module';

const CHECK_TIMEOUT_MS = 2_000;

type CheckResult = { status: 'up' } | { status: 'down'; error: string };

@ApiExcludeController()
@Public()
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly db: SystemPrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly metrics: MetricsService,
  ) {}

  /** Liveness: the process can serve HTTP. No dependency checks — a DB outage must not restart pods. */
  @Get('health')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable; K8s removes the pod from Service endpoints otherwise. */
  @Get('health/ready')
  async ready(@Res() res: Response): Promise<void> {
    const [database, redis] = await Promise.all([
      check(() => this.db.$queryRaw`SELECT 1`),
      check(() => this.redis.ping()),
    ]);
    const ok = database.status === 'up' && redis.status === 'up';
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({ status: ok ? 'ok' : 'degraded', checks: { database, redis } });
  }

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async prometheus(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}

async function check(fn: () => Promise<unknown>): Promise<CheckResult> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS).unref()),
    ]);
    return { status: 'up' };
  } catch (err) {
    return { status: 'down', error: err instanceof Error ? err.message : String(err) };
  }
}
