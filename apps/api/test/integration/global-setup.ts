import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node' with { 'resolution-mode': 'import' };

declare module 'vitest' {
  export interface ProvidedContext {
    testEnv: Record<string, string>;
  }
}

const DB_PACKAGE = resolve(__dirname, '../../../../packages/db');

/**
 * Real Postgres (pgvector) + Redis per test run: RLS, partitions, HNSW and Redis
 * pipelines are exactly what we need to prove, and mocks would prove nothing about them.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const pg: StartedPostgreSqlContainer = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('canon')
    .withUsername('canon')
    .withPassword('canon')
    .start();
  const redis: StartedRedisContainer = await new RedisContainer('redis:7.4-alpine').start();

  // Same role layout as docker/postgres/init: the API runs on canon_app so RLS is really exercised.
  await pg.exec([
    'psql', '-U', 'canon', '-d', 'canon', '-c',
    "CREATE ROLE canon_app LOGIN PASSWORD 'canon_app' NOBYPASSRLS; CREATE ROLE canon_system LOGIN PASSWORD 'canon_system' BYPASSRLS; GRANT CONNECT ON DATABASE canon TO canon_app, canon_system;",
  ]);

  const host = pg.getHost();
  const port = pg.getPort();
  const url = (user: string, pass: string) => `postgresql://${user}:${pass}@${host}:${port}/canon?schema=public`;
  const ownerUrl = url('canon', 'canon');

  const prisma = resolve(DB_PACKAGE, 'node_modules/.bin/prisma');
  execFileSync(process.platform === 'win32' ? `${prisma}.cmd` : prisma, ['migrate', 'deploy'], {
    cwd: DB_PACKAGE,
    env: { ...process.env, DATABASE_URL: ownerUrl },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
  // Seed provides the model registry, prompts and a SUPER_ADMIN.
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'prisma/seed.ts'], {
    cwd: DB_PACKAGE,
    env: { ...process.env, DATABASE_URL: ownerUrl, SYSTEM_DATABASE_URL: url('canon_system', 'canon_system'), SEED_ADMIN_EMAIL: 'root@canon.test', SEED_ADMIN_PASSWORD: 'root-password-for-tests' },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  project.provide('testEnv', {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    API_PUBLIC_URL: 'http://localhost:4000',
    ADMIN_PUBLIC_URL: 'http://localhost:3000',
    CORS_ORIGINS: 'http://localhost:3000',
    DATABASE_URL: ownerUrl,
    APP_DATABASE_URL: url('canon_app', 'canon_app'),
    SYSTEM_DATABASE_URL: url('canon_system', 'canon_system'),
    REDIS_URL: `redis://${redis.getHost()}:${redis.getPort()}`,
    JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    MAIL_TRANSPORT: 'memory',
    AI_DEFAULT_MODEL: 'ollama/llama3.1:8b',
    AI_FALLBACK_MODELS: '',
    AI_SEMANTIC_CACHE_ENABLED: 'false',
    LANGFUSE_BASE_URL: '',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    GOOGLE_API_KEY: '',
  });

  return async () => {
    await Promise.allSettled([pg.stop(), redis.stop()]);
  };
}
