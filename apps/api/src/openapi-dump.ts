import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { buildOpenApi } from './common/http/openapi';

/**
 * Writes the OpenAPI document for @canon/sdk without starting the server (`app.init()` is never
 * called, so no jobs, sockets or queue workers start). Needs the usual environment.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error'], abortOnError: false });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  const doc = buildOpenApi(app);
  const out = resolve(process.argv[2] ?? '../../packages/sdk/openapi.json');
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`OpenAPI: ${Object.keys(doc.paths).length} paths → ${out}\n`);
  process.exit(0);
}

void main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
