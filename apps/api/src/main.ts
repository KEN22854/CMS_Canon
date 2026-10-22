import { otelSdk } from './instrumentation';
import 'reflect-metadata';
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get(Logger);
  app.useLogger(logger);

  app.set('trust proxy', 1);
  app.use(helmet());
  // SSE must not be compressed: gzip buffers chunks and destroys token-by-token streaming.
  app.use(compression({ filter: (req, res) => !String(res.getHeader('Content-Type') ?? '').startsWith('text/event-stream') && compression.filter(req, res) }));
  app.useBodyParser('json', { limit: '10mb' });
  app.enableCors({
    // Per-tenant custom-domain origins are added in Phase 2 via a dynamic origin callback.
    origin: config.CORS_ORIGINS,
    credentials: true,
    exposedHeaders: ['x-request-id', 'retry-after'],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();

  if (config.NODE_ENV !== 'production') {
    const doc = new DocumentBuilder()
      .setTitle('Canon CMS API')
      .setDescription('AI-native headless CMS — REST v1')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, doc));
  }

  await app.listen(config.API_PORT);
  logger.log(`Canon API listening on ${config.API_PUBLIC_URL} (docs: ${config.API_PUBLIC_URL}/api/docs)`);
}

process.on('SIGTERM', () => {
  void otelSdk?.shutdown();
});

bootstrap().catch((err: unknown) => {
  // Logger may not exist yet (config validation failure); stderr is the only safe sink here.
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
