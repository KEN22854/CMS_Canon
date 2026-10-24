import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { subject } from '@casl/ability';
import { Y, draftToYDoc, type CollabDraft } from '@canon/collab';
import type { PageContent } from '@canon/blocks';
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { WebSocket, WebSocketServer } from 'ws';
import { defineAbilityFor } from '../../common/auth/abilities';
import { AccessTokenService } from '../../common/auth/access-token.service';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS } from '../../infrastructure/redis/redis.module';

// lib0 / y-protocols ship ESM typings next to CJS builds: load the CJS build, keep the typings.
/* eslint-disable @typescript-eslint/no-require-imports */
const decoding: typeof import('lib0/decoding', { with: { 'resolution-mode': 'import' } }) = require('lib0/decoding');
const encoding: typeof import('lib0/encoding', { with: { 'resolution-mode': 'import' } }) = require('lib0/encoding');
const awarenessProtocol: typeof import('y-protocols/awareness', { with: { 'resolution-mode': 'import' } }) = require('y-protocols/awareness');
const syncProtocol: typeof import('y-protocols/sync', { with: { 'resolution-mode': 'import' } }) = require('y-protocols/sync');
/* eslint-enable @typescript-eslint/no-require-imports */

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const PATH = '/v1/collab/';
const PERSIST_DEBOUNCE_MS = 1_500;
const ROOM_TTL_MS = 30_000;
const MAX_CONNECTIONS = 50;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

interface Conn {
  ws: WebSocket;
  userId: string;
  canEdit: boolean;
  /** Awareness client ids this connection controls (removed when it disconnects). */
  clients: Set<number>;
}

interface Room {
  name: string;
  tenantId: string;
  pageId: string;
  doc: Y.Doc;
  awareness: InstanceType<typeof awarenessProtocol.Awareness>;
  conns: Map<WebSocket, Conn>;
  persistTimer?: NodeJS.Timeout;
  closeTimer?: NodeJS.Timeout;
}

/**
 * Realtime co-editing of page drafts over the standard y-websocket protocol (sync + awareness).
 *
 *  - Auth happens at the HTTP upgrade: a valid access token for the page's tenant, `read` on the
 *    page to join, `update` to send edits — read-only peers still see live changes and presence.
 *  - The room's Y.Doc is persisted (debounced) to collab_documents with the page version it was
 *    built from; a version mismatch on load means someone saved outside the session, so the room
 *    re-seeds from the saved draft instead of resurrecting stale state.
 *  - Several API instances share rooms through Redis pub/sub (updates and awareness).
 *  - The database draft is still written by the clients' normal CAS saves (one elected leader per
 *    room), so validation, versions, Canon and the outbox all stay on their single path.
 */
@Injectable()
export class CollabServer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly rooms = new Map<string, Promise<Room>>();
  private readonly instance = randomUUID();
  private sub?: Redis;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly tokens: AccessTokenService,
    private readonly system: SystemPrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CollabServer.name);
  }

  onApplicationBootstrap(): void {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as import('node:http').Server | undefined;
    if (!server) return;
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!req.url?.startsWith(PATH)) return;
      void this.handleUpgrade(req, socket, head);
    });
    this.sub = this.redis.duplicate();
    this.sub.on('messageBuffer', (channel: Buffer, message: Buffer) => void this.onRemote(channel.toString(), message));
  }

  async onModuleDestroy(): Promise<void> {
    for (const r of this.rooms.values()) {
      const room = await r.catch(() => null);
      if (room) await this.persist(room).catch(() => undefined);
    }
    this.wss.close();
    await this.sub?.quit().catch(() => undefined);
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    try {
      const url = new URL(req.url!, 'http://local');
      const name = decodeURIComponent(url.pathname.slice(PATH.length));
      const m = /^page:([A-Za-z0-9_-]{1,40})$/.exec(name);
      if (!m) return reject(404, 'Not Found');
      const token = url.searchParams.get('token');
      if (!token) return reject(401, 'Unauthorized');
      const claims = await this.tokens.verifyAccess(token).catch(() => null);
      if (!claims?.tid) return reject(401, 'Unauthorized');
      const page = await this.system.page.findFirst({ where: { id: m[1], tenantId: claims.tid, deletedAt: null }, select: { id: true, tenantId: true, createdById: true } });
      if (!page) return reject(404, 'Not Found');
      const ability = defineAbilityFor({ actorType: 'user', userId: claims.sub, tenantId: claims.tid, sessionId: claims.sid, memberRole: claims.trl, systemRole: claims.srl });
      const pageSubject = subject('Page', { tenantId: page.tenantId, createdById: page.createdById });
      if (!ability.can('read', pageSubject)) return reject(403, 'Forbidden');
      const room = await this.room(name, page.tenantId, page.id);
      if (room.conns.size >= MAX_CONNECTIONS) return reject(503, 'Room Full');
      this.wss.handleUpgrade(req, socket, head, (ws) => this.join(room, ws, { ws, userId: claims.sub, canEdit: ability.can('update', pageSubject), clients: new Set() }));
    } catch (err) {
      this.logger.warn({ err }, 'collab.upgrade_failed');
      reject(500, 'Internal Server Error');
    }
  }

  private join(room: Room, ws: WebSocket, conn: Conn): void {
    clearTimeout(room.closeTimer);
    room.conns.set(ws, conn);
    ws.binaryType = 'arraybuffer';
    ws.on('message', (data: ArrayBuffer | Buffer) => {
      try {
        this.onMessage(room, conn, new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
      } catch (err) {
        this.logger.warn({ err }, 'collab.bad_message');
        ws.close(1003, 'bad message');
      }
    });
    ws.on('close', () => this.leave(room, conn));
    ws.on('error', () => this.leave(room, conn));

    // Greet: our state vector (client answers with what we lack) and current presence.
    const sync = encoding.createEncoder();
    encoding.writeVarUint(sync, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(sync, room.doc);
    send(ws, encoding.toUint8Array(sync));
    const states = [...room.awareness.getStates().keys()];
    if (states.length) {
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(room.awareness, states));
      send(ws, encoding.toUint8Array(aw));
    }
  }

  private onMessage(room: Room, conn: Conn, data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      if (conn.canEdit) syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn);
      else {
        // Read-only peers may ask for state (step 1) but their updates are ignored.
        const sub = decoding.readVarUint(decoder);
        if (sub === syncProtocol.messageYjsSyncStep1) syncProtocol.readSyncStep1(decoder, encoder, room.doc);
      }
      if (encoding.length(encoder) > 1) send(conn.ws, encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn);
    }
  }

  private leave(room: Room, conn: Conn): void {
    if (!room.conns.delete(conn.ws)) return;
    awarenessProtocol.removeAwarenessStates(room.awareness, [...conn.clients], null);
    if (room.conns.size === 0) {
      room.closeTimer = setTimeout(() => void this.close(room), ROOM_TTL_MS);
      room.closeTimer.unref();
    }
  }

  private async close(room: Room, force = false): Promise<void> {
    if (room.conns.size && !force) return;
    for (const c of room.conns.values()) c.ws.close(1001, 'room closed');
    room.conns.clear();
    this.rooms.delete(room.name);
    clearTimeout(room.persistTimer);
    await this.persist(room).catch((err: unknown) => this.logger.warn({ err, room: room.name }, 'collab.persist_failed'));
    await this.sub?.unsubscribe(channel(room.name)).catch(() => undefined);
    room.awareness.destroy();
    room.doc.destroy();
  }

  /** Persists and closes a room now, disconnecting its peers (tests, admin tooling). */
  async evict(name: string): Promise<void> {
    const room = await this.rooms.get(name);
    if (room) await this.close(room, true);
  }

  /** Public for tests: flushes a room's state now. */
  async flush(name: string): Promise<void> {
    const room = await this.rooms.get(name);
    if (room) await this.persist(room);
  }

  private room(name: string, tenantId: string, pageId: string): Promise<Room> {
    let r = this.rooms.get(name);
    if (!r) {
      r = this.open(name, tenantId, pageId);
      this.rooms.set(name, r);
      r.catch(() => this.rooms.delete(name));
    }
    return r;
  }

  private async open(name: string, tenantId: string, pageId: string): Promise<Room> {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null); // the server has no presence of its own
    const room: Room = { name, tenantId, pageId, doc, awareness, conns: new Map() };

    const [page, stored] = await Promise.all([
      this.system.page.findUniqueOrThrow({ where: { id: pageId }, select: { title: true, slug: true, description: true, seo: true, content: true, version: true } }),
      this.system.collabDocument.findUnique({ where: { name } }),
    ]);
    if (stored && stored.version === page.version) Y.applyUpdate(doc, new Uint8Array(stored.state), 'server');
    else {
      const draft: CollabDraft = { title: page.title, slug: page.slug, description: page.description ?? '', seo: (page.seo as Record<string, unknown>) ?? {}, content: page.content as unknown as PageContent };
      draftToYDoc(doc, draft, 'server');
    }

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const msg = encoding.createEncoder();
      encoding.writeVarUint(msg, MESSAGE_SYNC);
      syncProtocol.writeUpdate(msg, update);
      const bytes = encoding.toUint8Array(msg);
      for (const c of room.conns.values()) if (c !== origin) send(c.ws, bytes);
      if (origin !== 'redis' && origin !== 'server') void this.publish(name, 'u', update);
      clearTimeout(room.persistTimer);
      room.persistTimer = setTimeout(() => void this.persist(room).catch(() => undefined), PERSIST_DEBOUNCE_MS);
      room.persistTimer.unref();
    });
    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      const conn = [...room.conns.values()].find((c) => c === origin);
      if (conn) {
        for (const id of added) conn.clients.add(id);
        for (const id of removed) conn.clients.delete(id);
      }
      const update = awarenessProtocol.encodeAwarenessUpdate(awareness, changed);
      const msg = encoding.createEncoder();
      encoding.writeVarUint(msg, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(msg, update);
      const bytes = encoding.toUint8Array(msg);
      for (const c of room.conns.values()) send(c.ws, bytes);
      if (origin !== 'redis') void this.publish(name, 'a', update);
    });
    await this.sub?.subscribe(channel(name));
    return room;
  }

  private async persist(room: Room): Promise<void> {
    const page = await this.system.page.findUnique({ where: { id: room.pageId }, select: { version: true } });
    if (!page) return;
    const state = Buffer.from(Y.encodeStateAsUpdate(room.doc));
    await this.system.collabDocument.upsert({
      where: { name: room.name },
      create: { name: room.name, tenantId: room.tenantId, entityType: 'PAGE', entityId: room.pageId, state, version: page.version },
      update: { state, version: page.version },
    });
  }

  private async publish(name: string, kind: 'u' | 'a', payload: Uint8Array): Promise<void> {
    const header = Buffer.from(`${this.instance}${kind}`);
    await this.redis.publish(channel(name), Buffer.concat([header, Buffer.from(payload)])).catch(() => undefined);
  }

  private async onRemote(ch: string, message: Buffer): Promise<void> {
    const name = ch.slice('collab:'.length);
    const r = this.rooms.get(name);
    if (!r) return;
    const from = message.subarray(0, 36).toString();
    if (from === this.instance) return;
    const kind = String.fromCharCode(message[36]!);
    const payload = new Uint8Array(message.subarray(37));
    const room = await r;
    if (kind === 'u') Y.applyUpdate(room.doc, payload, 'redis');
    else awarenessProtocol.applyAwarenessUpdate(room.awareness, payload, 'redis');
  }
}

const channel = (name: string) => `collab:${name}`;

function send(ws: WebSocket, data: Uint8Array): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(data, (err) => err && ws.close());
}
