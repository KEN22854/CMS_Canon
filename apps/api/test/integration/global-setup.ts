import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
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
  // S3-compatible store, same image and identities as docker-compose (anonymous read on the media bucket).
  const s3: StartedTestContainer = await new GenericContainer('chrislusf/seaweedfs:3.80')
    .withEntrypoint(['/bin/sh', '-c'])
    .withCommand([
      "mkdir -p /etc/seaweedfs && printf '{\"identities\":[{\"name\":\"canon\",\"credentials\":[{\"accessKey\":\"canon\",\"secretKey\":\"canon-s3-secret\"}],\"actions\":[\"Admin\",\"Read\",\"List\",\"Tagging\",\"Write\"]},{\"name\":\"anonymous\",\"actions\":[\"Read:canon-media\"]}]}' > /etc/seaweedfs/s3.json && exec weed server -dir=/data -ip.bind=0.0.0.0 -volume.max=0 -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json",
    ])
    .withExposedPorts(8333, 9333)
    .withWaitStrategy(Wait.forHttp('/cluster/status', 9333).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();
  const s3Endpoint = `http://${s3.getHost()}:${s3.getMappedPort(8333)}`;
  const s3Client = new S3Client({ region: 'us-east-1', endpoint: s3Endpoint, forcePathStyle: true, credentials: { accessKeyId: 'canon', secretAccessKey: 'canon-s3-secret' } });
  // The S3 gateway can lag the master by a moment after startup.
  for (let i = 0; ; i++) {
    try {
      await s3Client.send(new CreateBucketCommand({ Bucket: 'canon-media' }));
      break;
    } catch (err) {
      if (i > 20) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

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
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'error',
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
    // Text calls land on llama (default); vision calls (alt text) need the VL model.
    AI_FALLBACK_MODELS: 'ollama/qwen2.5vl:7b',
    S3_ENDPOINT: s3Endpoint,
    S3_BUCKET: 'canon-media',
    S3_ACCESS_KEY: 'canon',
    S3_SECRET_KEY: 'canon-s3-secret',
    S3_PUBLIC_URL: `${s3Endpoint}/canon-media`,
    DELIVERY_TOKEN: 'test-delivery-token-0123456789',
    WEB_REVALIDATE_URL: '',
    AI_SEMANTIC_CACHE_ENABLED: 'false',
    LANGFUSE_BASE_URL: '',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    GOOGLE_API_KEY: '',
  });

  return async () => {
    await Promise.allSettled([pg.stop(), redis.stop(), s3.stop()]);
  };
}
