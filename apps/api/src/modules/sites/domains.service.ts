import { Prisma, type Site } from '@canon/db';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { resolveTxt } from 'node:dns/promises';
import { PinoLogger } from 'nestjs-pino';
import type { TenantPrincipal } from '../../common/auth/principal';
import { badRequest, conflict } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { Outbox } from '../../infrastructure/events/outbox';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { Queues } from '../../infrastructure/queue/queue.module';
import { REDIS } from '../../infrastructure/redis/redis.module';
import { NotificationsService } from '../notifications/notifications.service';
import { SitesService } from './sites.service';

const RECHECK_QUEUE = 'domain-recheck';
const RECHECK_EVERY_MS = 24 * 3_600_000;
/** A verified domain whose proof disappears keeps serving this long before it is released. */
const GRACE_MS = 7 * 86_400_000;
/** Pending domains are re-tried automatically for this long, so "add the record and wait" works. */
const PENDING_AUTOCHECK_MS = 7 * 86_400_000;

/**
 * Custom domains: a site claims a hostname (PENDING), proves control with a DNS TXT record
 * (VERIFIED) and only then is served on it and gets a certificate. A claim alone never blocks
 * anyone — uniqueness is enforced on verified domains only, so squatting a name is pointless.
 */
@Injectable()
export class DomainsService implements OnApplicationBootstrap {
  /** Swappable in tests. */
  lookupTxt: (name: string) => Promise<string[][]> = resolveTxt;

  constructor(
    private readonly system: SystemPrismaService,
    private readonly sites: SitesService,
    private readonly outbox: Outbox,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly queues: Queues,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DomainsService.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.DOMAIN_JOBS === 'off') return;
    this.queues.worker(RECHECK_QUEUE, () => this.recheckAll(), 1);
    await this.queues
      .queue(RECHECK_QUEUE)
      .upsertJobScheduler(
        'domain-recheck',
        { every: RECHECK_EVERY_MS },
        { name: 'recheck', data: {}, opts: { removeOnComplete: true, removeOnFail: 20 } },
      );
  }

  cnameTarget(): string {
    return this.config.SITES_CNAME_TARGET || `sites.${this.config.PUBLIC_SITES_DOMAIN}`;
  }

  present(s: Site) {
    if (!s.domain)
      return {
        domain: null,
        status: 'NONE' as const,
        records: [],
        verifiedAt: null,
        checkedAt: null,
        error: null,
      };
    return {
      domain: s.domain,
      status: s.domainStatus,
      verifiedAt: s.domainVerifiedAt,
      checkedAt: s.domainCheckedAt,
      error: s.domainError,
      records: [
        {
          type: 'TXT',
          name: `_canon-site.${s.domain}`,
          value: `canon-site=${s.domainToken ?? ''}`,
          purpose: 'Proves you control the domain. Keep it in place.',
        },
        {
          type: 'CNAME',
          name: s.domain,
          value: this.cnameTarget(),
          purpose:
            'Routes visitors to Canon. For an apex domain use ALIAS/ANAME or your DNS provider’s CNAME flattening.',
        },
      ],
    };
  }

  async status(tenantId: string, siteId: string) {
    return this.present(await this.sites.get(tenantId, siteId));
  }

  async verify(actor: TenantPrincipal, siteId: string) {
    const site = await this.sites.get(actor.tenantId, siteId);
    if (!site.domain) throw badRequest('NO_DOMAIN', 'Connect a domain first');
    if (site.domainStatus === 'VERIFIED') return this.present(site);
    const error = await this.check(site);
    if (error) {
      const row = await this.system.site.update({
        where: { id: site.id },
        data: { domainStatus: 'PENDING', domainCheckedAt: new Date(), domainError: error },
      });
      return this.present(row);
    }
    const row = await this.markVerified(site);
    await this.audit.record(
      {
        tenantId: actor.tenantId,
        action: 'site.domain_verified',
        entityType: 'Site',
        entityId: site.id,
        changes: { domain: site.domain },
      },
      actor,
    );
    return this.present(row);
  }

  /** Caddy on-demand TLS "ask": a certificate is only issued for hosts Canon actually serves. */
  async allowsCertificate(host: string): Promise<boolean> {
    const h = host.toLowerCase().replace(/\.$/, '');
    const site = await this.system.site.findFirst({
      where: { deletedAt: null, OR: [{ internalDomain: h }, { domain: h, domainStatus: 'VERIFIED' }] },
      select: { id: true },
    });
    return Boolean(site);
  }

  /** Daily: auto-verify recent claims and make sure verified domains still prove control. */
  async recheckAll(now = new Date()): Promise<{ verified: number; failing: number; released: number }> {
    const sites = await this.system.site.findMany({
      where: {
        deletedAt: null,
        domain: { not: null },
        OR: [
          { domainStatus: 'VERIFIED' },
          { domainStatus: 'PENDING', updatedAt: { gte: new Date(now.getTime() - PENDING_AUTOCHECK_MS) } },
        ],
      },
    });
    let verified = 0;
    let failing = 0;
    let released = 0;
    for (const site of sites) {
      const error = await this.check(site).catch((err: unknown) =>
        err instanceof Error ? err.message : String(err),
      );
      if (site.domainStatus === 'PENDING') {
        if (error)
          await this.system.site.update({
            where: { id: site.id },
            data: { domainCheckedAt: now, domainError: error },
          });
        else if (
          await this.markVerified(site).then(
            () => true,
            () => false,
          )
        )
          verified++;
        continue;
      }
      const failKey = `domain-fail:${site.id}`;
      if (!error) {
        await this.redis.del(failKey);
        await this.system.site.update({
          where: { id: site.id },
          data: { domainCheckedAt: now, domainError: null },
        });
        continue;
      }
      failing++;
      await this.redis.set(failKey, String(now.getTime()), 'NX');
      const since = Number((await this.redis.get(failKey)) ?? now.getTime());
      if (now.getTime() - since < GRACE_MS) {
        await this.system.site.update({
          where: { id: site.id },
          data: { domainCheckedAt: now, domainError: error },
        });
        await this.notify(
          site,
          `${site.domain} no longer proves ownership`,
          `${error}. The site keeps serving for 7 days; restore the TXT record to keep the domain.`,
          `warn:${new Date(since).toISOString().slice(0, 10)}`,
        );
        continue;
      }
      released++;
      await this.system.site.update({
        where: { id: site.id },
        data: { domainStatus: 'FAILED', domainCheckedAt: now, domainError: error },
      });
      await this.redis.del(failKey);
      await this.siteHostsChanged(site);
      await this.notify(
        site,
        `${site.domain} was disconnected`,
        `${error}. The site is served on ${site.internalDomain} again until the domain is verified.`,
        `failed:${now.toISOString().slice(0, 10)}`,
      );
      this.logger.warn(
        { siteId: site.id, domain: site.domain },
        'custom domain released after failed rechecks',
      );
    }
    return { verified, failing, released };
  }

  /** null when the TXT proof is in place, else a human-readable reason. */
  private async check(site: Site): Promise<string | null> {
    if (this.config.SITE_DOMAIN_VERIFICATION === 'off') return null;
    const name = `_canon-site.${site.domain}`;
    const records = await this.lookupTxt(name).catch(() => [] as string[][]);
    return records.some((r) => r.join('') === `canon-site=${site.domainToken}`)
      ? null
      : `TXT record not found at ${name} (DNS changes can take a few minutes)`;
  }

  private async markVerified(site: Site): Promise<Site> {
    try {
      const row = await this.system.site.update({
        where: { id: site.id },
        data: {
          domainStatus: 'VERIFIED',
          domainVerifiedAt: new Date(),
          domainCheckedAt: new Date(),
          domainError: null,
        },
      });
      await this.siteHostsChanged(site);
      await this.notify(
        site,
        `${site.domain} is live`,
        `Visitors now reach “${site.name}” on ${site.domain}. The HTTPS certificate is issued on the first visit.`,
        'verified',
      );
      return row;
    } catch (err) {
      // The partial unique index: someone else verified the same hostname first.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw conflict('This domain is already verified by another site');
      throw err;
    }
  }

  private async siteHostsChanged(site: Site): Promise<void> {
    await this.system.$transaction((tx) =>
      this.outbox.enqueue(tx, {
        tenantId: site.tenantId,
        aggregateType: 'Site',
        aggregateId: site.id,
        type: 'SiteUpdated',
        payload: {
          siteId: site.id,
          hosts: [site.internalDomain, site.domain].filter((h): h is string => Boolean(h)),
        },
      }),
    );
  }

  private notify(site: Site, title: string, message: string, key: string) {
    return this.notifications.notifyRoles(site.tenantId, ['OWNER', 'ADMIN'], {
      type: 'domain.status',
      title,
      message,
      link: `/sites/${site.id}/settings`,
      data: { siteId: site.id, domain: site.domain },
      dedupeKey: `domain:${site.id}:${site.domain}:${key}`,
    });
  }
}
