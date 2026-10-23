import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { Request } from 'express';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuthCoreModule } from './common/auth/auth-core.module';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { ConfigModule } from './config/config.module';
import { APP_CONFIG, type AppConfig } from './config/env';
import { AuditModule } from './infrastructure/audit/audit.service';
import { BlocksModule } from './infrastructure/blocks/block-registry';
import { EventsModule } from './infrastructure/events/outbox';
import { QueueModule } from './infrastructure/queue/queue.module';
import { StorageModule } from './infrastructure/storage/storage';
import { MailModule } from './infrastructure/mail/mailer';
import { MetricsModule } from './infrastructure/metrics/metrics.module';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { ContentAiModule } from './modules/content-ai/content-ai.module';
import { FactsModule } from './modules/facts/facts.module';
import { CollectionsModule } from './modules/collections/collections.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { IntelligenceModule } from './modules/intelligence/intelligence.module';
import { MediaModule } from './modules/media/media.module';
import { PagesModule } from './modules/pages/pages.module';
import { SitesModule } from './modules/sites/sites.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';

const REQUEST_ID_HEADER = 'x-request-id';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.LOG_LEVEL,
          // Honour an upstream id (ingress/CDN) so one id spans edge → API → LLM trace.
          genReqId: (req, res) => {
            const incoming = req.headers[REQUEST_ID_HEADER];
            const id = typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
            res.setHeader(REQUEST_ID_HEADER, id);
            return id;
          },
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]', 'res.headers["set-cookie"]'],
            censor: '[redacted]',
          },
          customProps: (req) => ({ tenantId: (req as Request).principal?.tenantId }),
          autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' },
          transport: config.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
        },
      }),
    }),
    MetricsModule,
    PrismaModule,
    RedisModule,
    MailModule,
    AuditModule,
    EventsModule,
    QueueModule,
    StorageModule,
    BlocksModule,
    AuthCoreModule,
    HealthModule,
    IdentityModule,
    TenancyModule,
    ApiKeysModule,
    IntelligenceModule,
    SitesModule,
    PagesModule,
    MediaModule,
    ContentAiModule,
    FactsModule,
    CollectionsModule,
    DeliveryModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
