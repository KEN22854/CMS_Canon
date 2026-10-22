import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { AppConfig } from './config/env';

/**
 * HTTP pipeline shared by main.ts and the integration tests, so tests exercise exactly the
 * middleware stack production runs (proxy trust, cookies, CORS, versioning).
 */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  // req.ip = first X-Forwarded-For hop outside the trusted (internal) networks.
  app.set('trust proxy', config.TRUST_PROXY.split(',').map((s) => s.trim()));
  app.use(helmet());
  // SSE must not be compressed: gzip buffers chunks and destroys token-by-token streaming.
  app.use(compression({ filter: (req, res) => !String(res.getHeader('Content-Type') ?? '').startsWith('text/event-stream') && compression.filter(req, res) }));
  app.useBodyParser('json', { limit: '10mb' });
  app.use(cookieParser());
  app.enableCors({
    // Per-tenant custom-domain origins are added in Phase 2 via a dynamic origin callback.
    origin: [...new Set([...config.CORS_ORIGINS, new URL(config.ADMIN_PUBLIC_URL).origin])],
    credentials: true,
    exposedHeaders: ['x-request-id', 'retry-after'],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
}
