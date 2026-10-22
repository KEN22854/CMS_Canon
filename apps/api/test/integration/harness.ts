import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { inject } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { APP_CONFIG, type AppConfig } from '../../src/config/env';
import { MemoryMailer } from '../../src/infrastructure/mail/mailer';
import { SystemPrismaService } from '../../src/infrastructure/prisma/prisma.service';

export const PASSWORD = 'correct horse battery staple 42';

/**
 * Stand-in for Ollama's /api/chat so AI flows run end-to-end (gateway → quota → ledger) without
 * a GPU or API keys. A prompt containing "[slow]" holds the response to test concurrency limits.
 */
export async function startFakeOllama(): Promise<{ url: string; close: () => Promise<void>; calls: number }> {
  const state = { calls: 0 };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      state.calls += 1;
      const body = JSON.parse(raw || '{}') as { messages?: { content: string }[]; stream?: boolean };
      const last = body.messages?.at(-1)?.content ?? '';
      const reply = `echo: ${last.slice(0, 40)}`;
      const send = () => {
        if (body.stream) {
          res.setHeader('content-type', 'application/x-ndjson');
          res.write(`${JSON.stringify({ message: { content: reply.slice(0, 5) }, done: false })}\n`);
          res.end(`${JSON.stringify({ message: { content: reply.slice(5) }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 6 })}\n`);
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: { content: reply }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 6 }));
      };
      if (last.includes('[slow]')) setTimeout(send, 400);
      else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get calls() {
      return state.calls;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export interface TestApp {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  mailer: MemoryMailer;
  system: SystemPrismaService;
  config: AppConfig;
  close: () => Promise<void>;
}

export async function createTestApp(extraEnv: Record<string, string> = {}): Promise<TestApp> {
  Object.assign(process.env, inject('testEnv'), extraEnv);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  const config = app.get<AppConfig>(APP_CONFIG);
  configureApp(app, config);
  await app.init();
  return {
    app,
    http: request(app.getHttpServer()),
    mailer: app.get(MemoryMailer),
    system: app.get(SystemPrismaService),
    config,
    close: () => app.close(),
  };
}

/** Distinct client IP per call so IP-based auth rate limits don't couple unrelated tests. */
export function ip(): string {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2]}`;
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}.${randomBytes(4).toString('hex')}@canon.test`;
}

export function tokenFromMail(mailer: MemoryMailer, to: string, pattern: RegExp): string {
  const mail = mailer.lastTo(to);
  const m = mail?.text.match(pattern);
  if (!m?.[1]) throw new Error(`No token matching ${pattern} in mail to ${to}: ${mail?.text ?? '(none)'}`);
  return m[1];
}

export function refreshCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : [String(raw ?? '')];
  const c = list.find((x) => x.startsWith('canon_rt='));
  if (!c) throw new Error('No refresh cookie in response');
  return c.split(';')[0]!;
}

export interface SignedIn {
  email: string;
  accessToken: string;
  cookie: string;
  userId: string;
  tenantId: string;
}

/** Full happy path: register → verification mail → verify (auto sign-in). */
export async function signUp(t: TestApp, opts: { email?: string; name?: string; tenantName?: string } = {}): Promise<SignedIn> {
  const email = opts.email ?? uniqueEmail();
  await t.http
    .post('/v1/auth/register')
    .set('x-forwarded-for', ip())
    .send({ email, password: PASSWORD, name: opts.name ?? 'Test User', tenantName: opts.tenantName ?? 'Test Workspace' })
    .expect(202);
  const token = tokenFromMail(t.mailer, email, /verify-email\?token=([\w-]+)/);
  const res = await t.http.post('/v1/auth/verify-email').set('x-forwarded-for', ip()).send({ token }).expect(200);
  return { email, accessToken: res.body.accessToken, cookie: refreshCookie(res), userId: res.body.user.id, tenantId: res.body.tenant.id };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
