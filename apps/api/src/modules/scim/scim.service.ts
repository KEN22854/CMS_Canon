import type { MemberRole, TenantMember, User } from '@canon/db';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { TenantPrincipal } from '../../common/auth/principal';
import { SessionRevoker } from '../../common/auth/session-revoker';
import { randomToken, safeEqual, sha256 } from '../../common/crypto/tokens';
import { ApiError, notFound } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { effectiveLimits } from '../tenancy/plans';

export const SCIM_TOKEN_PREFIX = 'cs_';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const CANON_EXT = 'urn:ietf:params:scim:schemas:extension:canon:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
/** Roles an IdP may assign. Ownership is never provisioned. */
const SCIM_ROLES = ['ADMIN', 'EDITOR', 'AUTHOR', 'VIEWER'] as const;

/** SCIM errors use their own wire format (RFC 7644 §3.12); ScimExceptionFilter renders them. */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?: string,
  ) {
    super(message);
  }
}

export const createScimTokenBody = z.object({ name: z.string().trim().min(2).max(80) }).strict();

const scimUser = z
  .object({
    userName: z.string().trim().min(3).max(254),
    externalId: z.string().max(255).optional(),
    active: z.boolean().optional(),
    name: z
      .object({
        formatted: z.string().max(200).optional(),
        givenName: z.string().max(100).optional(),
        familyName: z.string().max(100).optional(),
      })
      .partial()
      .optional(),
    displayName: z.string().max(200).optional(),
    emails: z
      .array(
        z.object({
          value: z.string().max(254),
          primary: z.boolean().optional(),
          type: z.string().optional(),
        }),
      )
      .max(10)
      .optional(),
    [CANON_EXT]: z.object({ role: z.string().optional() }).optional(),
  })
  .passthrough();
export type ScimUserInput = z.infer<typeof scimUser>;

const patchOp = z.object({
  schemas: z.array(z.string()).optional(),
  Operations: z
    .array(z.object({ op: z.string(), path: z.string().optional(), value: z.unknown().optional() }))
    .min(1)
    .max(50),
});

type Member = TenantMember & { user: User };

/**
 * SCIM 2.0 provisioning of workspace members (Users only). The identity provider owns who is in
 * the workspace: creating a user adds a membership, `active: false` or DELETE removes it and
 * forces the person's sessions to re-check membership. Users are matched by e-mail, and only
 * e-mails on the workspace's verified SSO domains can be provisioned.
 */
@Injectable()
export class ScimService {
  constructor(
    private readonly system: SystemPrismaService,
    private readonly audit: AuditService,
    private readonly revoker: SessionRevoker,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  baseUrl(): string {
    return `${this.config.ADMIN_PUBLIC_URL}/api/scim/v2`;
  }

  // ── tokens (admin API) ─────────────────────────────────────────────────────

  async listTokens(tenantId: string) {
    const rows = await this.system.scimToken.findMany({
      where: { tenantId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, keyPrefix: true, lastUsedAt: true, createdAt: true },
    });
    return { baseUrl: this.baseUrl(), tokens: rows };
  }

  async createToken(actor: TenantPrincipal, name: string) {
    const tenant = await this.system.tenant.findUniqueOrThrow({
      where: { id: actor.tenantId },
      select: { plan: true },
    });
    if (tenant.plan !== 'ENTERPRISE')
      throw new ApiError(
        'PLAN_REQUIRED',
        'SCIM provisioning is part of the Enterprise plan',
        HttpStatus.PAYMENT_REQUIRED,
        { plan: 'ENTERPRISE', limits: effectiveLimits(tenant.plan, {}) },
      );
    const lookup = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8);
    const token = `${SCIM_TOKEN_PREFIX}${lookup}_${randomToken(32)}`;
    const row = await this.system.scimToken.create({
      data: {
        tenantId: actor.tenantId,
        name,
        keyPrefix: `${SCIM_TOKEN_PREFIX}${lookup}`,
        tokenHash: sha256(token),
        createdById: actor.userId ?? null,
      },
    });
    await this.audit.record(
      {
        tenantId: actor.tenantId,
        action: 'scim.token_created',
        entityType: 'ScimToken',
        entityId: row.id,
        changes: { name },
      },
      actor,
    );
    return {
      id: row.id,
      name,
      keyPrefix: row.keyPrefix,
      token,
      baseUrl: this.baseUrl(),
      createdAt: row.createdAt,
    };
  }

  async revokeToken(actor: TenantPrincipal, id: string): Promise<void> {
    const res = await this.system.scimToken.updateMany({
      where: { id, tenantId: actor.tenantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!res.count) throw notFound('SCIM token');
    await this.audit.record(
      { tenantId: actor.tenantId, action: 'scim.token_revoked', entityType: 'ScimToken', entityId: id },
      actor,
    );
  }

  /** Bearer token → tenant. Revoked tokens and workspaces that left Enterprise stop working. */
  async authenticate(raw: string | undefined): Promise<{ tenantId: string; tokenId: string }> {
    if (!raw?.startsWith(SCIM_TOKEN_PREFIX)) throw new ScimError(401, 'A SCIM bearer token is required');
    const hash = sha256(raw);
    const rows = await this.system.scimToken.findMany({
      where: { keyPrefix: raw.slice(0, SCIM_TOKEN_PREFIX.length + 8), revokedAt: null },
      select: { id: true, tenantId: true, tokenHash: true },
    });
    const t = rows.find((r) => safeEqual(r.tokenHash, hash));
    const tenant = t
      ? await this.system.tenant.findUnique({
          where: { id: t.tenantId },
          select: { plan: true, deletedAt: true },
        })
      : null;
    if (!t || !tenant || tenant.deletedAt || tenant.plan !== 'ENTERPRISE')
      throw new ScimError(401, 'Invalid SCIM token');
    void this.system.scimToken
      .update({ where: { id: t.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    return { tenantId: t.tenantId, tokenId: t.id };
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  async listUsers(tenantId: string, q: { filter?: string; startIndex?: string; count?: string }) {
    const start = Math.max(1, Number(q.startIndex) || 1);
    const count = Math.min(200, Math.max(0, Number(q.count ?? 100) || 0));
    const where: { tenantId: string; user?: object; externalId?: string } = { tenantId };
    if (q.filter) {
      const f = parseFilter(q.filter);
      if (f.attr === 'username' || f.attr === 'emails' || f.attr === 'emails.value')
        where.user = { email: f.value.toLowerCase() };
      else if (f.attr === 'externalid') where.externalId = f.value;
      else throw new ScimError(400, `Filtering on ${f.attr} is not supported`, 'invalidFilter');
    }
    const [total, rows] = await Promise.all([
      this.system.tenantMember.count({ where }),
      this.system.tenantMember.findMany({
        where,
        include: { user: true },
        orderBy: { createdAt: 'asc' },
        skip: start - 1,
        take: count,
      }),
    ]);
    return {
      schemas: [LIST_SCHEMA],
      totalResults: total,
      startIndex: start,
      itemsPerPage: rows.length,
      Resources: rows.map((m) => this.present(m)),
    };
  }

  async getUser(tenantId: string, id: string) {
    return this.present(await this.member(tenantId, id));
  }

  async createUser(tenantId: string, tokenId: string, raw: unknown) {
    const body = parse(scimUser, raw);
    const email = await this.provisionableEmail(tenantId, body);
    let user = await this.system.user.findUnique({ where: { email } });
    if (user && (user.deletedAt || user.status === 'DISABLED' || user.status === 'SUSPENDED'))
      throw new ScimError(409, 'This account is disabled', 'uniqueness');
    if (
      user &&
      (await this.system.tenantMember.findUnique({
        where: { tenantId_userId: { tenantId, userId: user.id } },
      }))
    )
      throw new ScimError(409, `${email} is already a member`, 'uniqueness');
    if (body.active === false)
      throw new ScimError(400, 'Create the user as active, or skip it', 'invalidValue');
    if (
      body.externalId &&
      (await this.system.tenantMember.findUnique({
        where: { tenantId_externalId: { tenantId, externalId: body.externalId } },
      }))
    )
      throw new ScimError(409, 'externalId is already in use', 'uniqueness');
    if (!user) {
      user = await this.system.user.create({
        data: {
          email,
          name: displayName(body) ?? email.split('@')[0]!,
          status: 'ACTIVE',
          emailVerified: new Date(),
        },
      });
    } else if (!user.emailVerified || user.status === 'PENDING_VERIFICATION') {
      user = await this.system.user.update({
        where: { id: user.id },
        data: { emailVerified: new Date(), status: 'ACTIVE' },
      });
    }
    const role = await this.roleFor(tenantId, body);
    const m = await this.system.tenantMember.create({
      data: {
        tenantId,
        userId: user.id,
        role,
        externalId: body.externalId ?? null,
        scimManaged: true,
        joinedAt: new Date(),
      },
      include: { user: true },
    });
    await this.audit.record(
      {
        tenantId,
        action: 'member.provisioned_by_scim',
        entityType: 'Member',
        entityId: user.id,
        changes: { email, role, token: tokenId },
      },
      undefined,
    );
    return this.present(m);
  }

  /** PUT: full replace of the attributes Canon stores. */
  async replaceUser(tenantId: string, tokenId: string, id: string, raw: unknown) {
    const body = parse(scimUser, raw);
    const m = await this.member(tenantId, id);
    if (body.active === false) return this.deactivate(m, tokenId);
    return this.apply(m, {
      name: displayName(body),
      externalId: body.externalId ?? null,
      role: body[CANON_EXT]?.role ? await this.roleFor(tenantId, body) : undefined,
    });
  }

  /** PATCH (RFC 7644 §3.5.2): the subset IdPs actually send — active, name, externalId, role. */
  async patchUser(tenantId: string, tokenId: string, id: string, raw: unknown) {
    const body = parse(patchOp, raw);
    const m = await this.member(tenantId, id);
    const changes: { name?: string; externalId?: string | null; role?: MemberRole } = {};
    let active: boolean | undefined;
    for (const op of body.Operations) {
      const kind = op.op.toLowerCase();
      if (kind !== 'replace' && kind !== 'add')
        throw new ScimError(400, `Unsupported operation ${op.op}`, 'invalidSyntax');
      // Without a path, the value is a partial resource (Azure AD/Okta both do this).
      const entries = op.path
        ? [[op.path, op.value] as const]
        : Object.entries((op.value ?? {}) as Record<string, unknown>);
      for (const [path, value] of entries) {
        const p = path.toLowerCase();
        if (p === 'active') active = value === true || value === 'true' || value === 'True';
        else if (p === 'displayname' || p === 'name.formatted') changes.name = String(value).slice(0, 200);
        else if (p === 'name' && value && typeof value === 'object')
          changes.name = displayName({ name: value as ScimUserInput['name'] }) ?? changes.name;
        else if (p === 'name.givenname' || p === 'name.familyname')
          changes.name = changes.name ?? m.user.name;
        else if (p === 'externalid') changes.externalId = value ? String(value) : null;
        else if (p === `${CANON_EXT}:role`.toLowerCase() || p === 'role') changes.role = toRole(value);
        else if (p === CANON_EXT.toLowerCase() && value && typeof value === 'object')
          changes.role = toRole((value as { role?: unknown }).role);
        // Attributes Canon does not store (phone numbers, titles…) are accepted and ignored.
      }
    }
    if (active === false) return this.deactivate(m, tokenId);
    return this.apply(m, changes);
  }

  async deleteUser(tenantId: string, tokenId: string, id: string): Promise<void> {
    await this.deactivate(await this.member(tenantId, id), tokenId);
  }

  // ── discovery ──────────────────────────────────────────────────────────────

  serviceProviderConfig() {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: 'https://github.com/KEN22854/CMS_Canon/blob/main/docs/auth.md',
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'Bearer token',
          description: 'A SCIM token created in Settings → Single sign-on',
          primary: true,
        },
      ],
      meta: { resourceType: 'ServiceProviderConfig', location: `${this.baseUrl()}/ServiceProviderConfig` },
    };
  }

  resourceTypes() {
    return {
      schemas: [LIST_SCHEMA],
      totalResults: 1,
      Resources: [
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'User',
          name: 'User',
          endpoint: '/Users',
          schema: USER_SCHEMA,
          schemaExtensions: [{ schema: CANON_EXT, required: false }],
          meta: { resourceType: 'ResourceType', location: `${this.baseUrl()}/ResourceTypes/User` },
        },
      ],
    };
  }

  schemas() {
    const attr = (name: string, extra: object = {}) => ({
      name,
      type: 'string',
      multiValued: false,
      required: false,
      caseExact: false,
      mutability: 'readWrite',
      returned: 'default',
      uniqueness: 'none',
      ...extra,
    });
    return {
      schemas: [LIST_SCHEMA],
      totalResults: 2,
      Resources: [
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
          id: USER_SCHEMA,
          name: 'User',
          attributes: [
            attr('userName', { required: true, uniqueness: 'server' }),
            attr('displayName'),
            attr('active', { type: 'boolean' }),
            attr('externalId'),
          ],
          meta: { resourceType: 'Schema' },
        },
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
          id: CANON_EXT,
          name: 'CanonUser',
          description: 'Workspace role',
          attributes: [attr('role', { canonicalValues: [...SCIM_ROLES] })],
          meta: { resourceType: 'Schema' },
        },
      ],
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async member(tenantId: string, userId: string): Promise<Member> {
    const m = await this.system.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      include: { user: true },
    });
    if (!m) throw new ScimError(404, `User ${userId} not found`);
    return m;
  }

  private async apply(m: Member, c: { name?: string; externalId?: string | null; role?: MemberRole }) {
    // Owners stay in control of their own role; the IdP cannot demote them.
    const role = c.role && m.role !== 'OWNER' && c.role !== m.role ? c.role : undefined;
    if (
      c.externalId &&
      c.externalId !== m.externalId &&
      (await this.system.tenantMember.findUnique({
        where: { tenantId_externalId: { tenantId: m.tenantId, externalId: c.externalId } },
      }))
    ) {
      throw new ScimError(409, 'externalId is already in use', 'uniqueness');
    }
    if (c.name && c.name !== m.user.name && m.scimManaged)
      await this.system.user.update({ where: { id: m.userId }, data: { name: c.name } });
    const row = await this.system.tenantMember.update({
      where: { id: m.id },
      data: {
        ...(c.externalId !== undefined ? { externalId: c.externalId } : {}),
        ...(role ? { role } : {}),
        scimManaged: true,
      },
      include: { user: true },
    });
    if (role) {
      await this.revoker.forceRefresh(m.userId, m.tenantId);
      await this.audit.record(
        {
          tenantId: m.tenantId,
          action: 'member.role_changed_by_scim',
          entityType: 'Member',
          entityId: m.userId,
          changes: { from: m.role, to: role },
        },
        undefined,
      );
    }
    return this.present(row);
  }

  private async deactivate(m: Member, tokenId: string) {
    if (
      m.role === 'OWNER' &&
      (await this.system.tenantMember.count({ where: { tenantId: m.tenantId, role: 'OWNER' } })) <= 1
    )
      throw new ScimError(409, 'The last owner cannot be deprovisioned', 'mutability');
    await this.system.tenantMember.delete({ where: { id: m.id } });
    await this.revoker.forceRefresh(m.userId, m.tenantId);
    await this.audit.record(
      {
        tenantId: m.tenantId,
        action: 'member.deprovisioned_by_scim',
        entityType: 'Member',
        entityId: m.userId,
        changes: { email: m.user.email, role: m.role, token: tokenId },
      },
      undefined,
    );
    return { ...this.present(m), active: false };
  }

  private async provisionableEmail(tenantId: string, body: ScimUserInput): Promise<string> {
    const email = (body.emails?.find((e) => e.primary)?.value ?? body.emails?.[0]?.value ?? body.userName)
      .trim()
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw new ScimError(400, 'userName (or a primary e-mail) must be an e-mail address', 'invalidValue');
    const sso = await this.system.ssoConnection.findUnique({
      where: { tenantId },
      select: { verifiedDomains: true },
    });
    // Same trust boundary as SSO: the IdP speaks only for domains the workspace proved it owns.
    if (!sso?.verifiedDomains.includes(email.split('@')[1]!))
      throw new ScimError(
        400,
        `${email} is not on a verified domain of this workspace's SSO connection`,
        'invalidValue',
      );
    return email;
  }

  private async roleFor(tenantId: string, body: ScimUserInput): Promise<MemberRole> {
    const requested = body[CANON_EXT]?.role;
    if (requested) return toRole(requested);
    const sso = await this.system.ssoConnection.findUnique({
      where: { tenantId },
      select: { defaultRole: true },
    });
    return sso && sso.defaultRole !== 'OWNER' ? sso.defaultRole : 'VIEWER';
  }

  private present(m: Member) {
    const [givenName, ...rest] = m.user.name.split(' ');
    return {
      schemas: [USER_SCHEMA, CANON_EXT],
      id: m.userId,
      externalId: m.externalId ?? undefined,
      userName: m.user.email,
      displayName: m.user.name,
      name: { formatted: m.user.name, givenName, familyName: rest.join(' ') || undefined },
      emails: [{ value: m.user.email, primary: true, type: 'work' }],
      active: true,
      [CANON_EXT]: { role: m.role },
      meta: {
        resourceType: 'User',
        created: m.createdAt.toISOString(),
        lastModified: m.updatedAt.toISOString(),
        location: `${this.baseUrl()}/Users/${m.userId}`,
      },
    };
  }
}

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const r = schema.safeParse(raw);
  if (!r.success)
    throw new ScimError(
      400,
      r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      'invalidValue',
    );
  return r.data;
}

function toRole(v: unknown): MemberRole {
  const r = String(v ?? '').toUpperCase();
  if (!(SCIM_ROLES as readonly string[]).includes(r))
    throw new ScimError(400, `role must be one of ${SCIM_ROLES.join(', ')}`, 'invalidValue');
  return r as MemberRole;
}

function displayName(b: Pick<ScimUserInput, 'displayName' | 'name'>): string | undefined {
  const n =
    b.displayName ?? b.name?.formatted ?? [b.name?.givenName, b.name?.familyName].filter(Boolean).join(' ');
  return n?.trim() ? n.trim().slice(0, 200) : undefined;
}

/** The one filter shape IdPs send: `attr eq "value"`. */
function parseFilter(filter: string): { attr: string; value: string } {
  const m = /^\s*([\w.:]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!m) throw new ScimError(400, 'Only `attribute eq "value"` filters are supported', 'invalidFilter');
  return {
    attr: m[1]!.toLowerCase().replace(/^urn:ietf:params:scim:schemas:core:2\.0:user:/, ''),
    value: m[2]!.replace(/\\(.)/g, '$1'),
  };
}
