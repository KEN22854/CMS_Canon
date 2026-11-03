import { otelSdk } from './instrumentation';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { buildOpenApi } from './common/http/openapi';
import { APP_CONFIG, type AppConfig } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get(Logger);
  app.useLogger(logger);
  configureApp(app, config);
  app.enableShutdownHooks();

  if (config.NODE_ENV !== 'production') {
    SwaggerModule.setup('api/docs', app, () => buildOpenApi(app));
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
