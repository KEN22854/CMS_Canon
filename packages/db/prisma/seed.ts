import { resolve } from 'node:path';
import { config } from 'dotenv';
import { hash } from '@node-rs/argon2';
import {
  ContentEntityType,
  ContentStatus,
  FactSourceKind,
  FactValueType,
  MemberRole,
  MentionKind,
  MentionState,
  Prisma,
  PrismaClient,
  TenantPlan,
  UserRole,
  UserStatus,
  FactChangeOrigin,
} from '@prisma/client';
import { AI_AGENTS, AI_MODELS, AI_PROMPTS, AI_PROVIDERS } from './seed/ai';
import { CORE_BLOCKS, toJsonSchema } from './seed/blocks';

config({ path: resolve(__dirname, '../../../.env') });

// Seed is cross-tenant by nature, so it uses the BYPASSRLS system role when available.
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL } },
});

const DEMO = {
  tenantSlug: 'acme',
  siteSlug: 'acme-cloud',
  internalDomain: 'acme-cloud.canon.localhost',
} as const;

const log = (msg: string): void => {
  process.stdout.write(`[seed] ${msg}\n`);
};

async function seedAiRegistry(): Promise<Map<string, string>> {
  const modelIds = new Map<string, string>();
  for (const p of AI_PROVIDERS) {
    const config = 'config' in p ? p.config : {};
    await prisma.aiProvider.upsert({
      where: { name: p.name },
      create: { name: p.name, displayName: p.displayName, config },
      update: { displayName: p.displayName, config },
    });
  }
  const providers = await prisma.aiProvider.findMany();
  const providerId = new Map(providers.map((p) => [p.name, p.id]));

  for (const m of AI_MODELS) {
    const pid = providerId.get(m.provider);
    if (!pid) throw new Error(`Unknown provider ${m.provider}`);
    const data = {
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      inputPricePer1M: new Prisma.Decimal(m.inputPricePer1M),
      outputPricePer1M: new Prisma.Decimal(m.outputPricePer1M),
      capabilities: m.capabilities,
      tier: m.tier,
      embeddingDims: m.embeddingDims ?? null,
    };
    const row = await prisma.aiModel.upsert({
      where: { providerId_name: { providerId: pid, name: m.name } },
      create: { providerId: pid, name: m.name, ...data },
      update: data,
    });
    modelIds.set(m.name, row.id);
  }

  for (const p of AI_PROMPTS) {
    // Global prompts have tenantId NULL, which Prisma's compound-unique upsert cannot target.
    const existing = await prisma.aiPrompt.findFirst({ where: { tenantId: null, name: p.name, version: 1 } });
    const data = {
      feature: p.feature,
      system: p.system,
      template: p.template,
      variables: p.variables,
      modelKey: p.modelKey ?? null,
    };
    if (existing) await prisma.aiPrompt.update({ where: { id: existing.id }, data });
    else await prisma.aiPrompt.create({ data: { name: p.name, version: 1, ...data } });
  }
  log(`AI registry: ${AI_PROVIDERS.length} providers, ${AI_MODELS.length} models, ${AI_PROMPTS.length} prompts`);
  return modelIds;
}

async function seedBlocks(): Promise<void> {
  for (const b of CORE_BLOCKS) {
    const { schema, defaults } = toJsonSchema(b);
    const data = {
      name: b.name,
      icon: b.icon,
      category: b.category,
      schema,
      defaults: defaults as Prisma.InputJsonValue,
      isCore: true,
      isContainer: b.isContainer ?? false,
      allowedChildren: b.allowedChildren ?? [],
      aiGeneratable: b.category !== 'advanced',
      rendererKey: `core/${b.type}`,
    };
    await prisma.block.upsert({ where: { type: b.type }, create: { type: b.type, ...data }, update: data });
  }
  log(`Blocks: ${CORE_BLOCKS.length}`);
}

async function seedAdmin(): Promise<string> {
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@canon.local';
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must be set (≥ 12 chars) — see .env.example');
  }
  const passwordHash = await hash(password);
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash,
      name: 'Super Admin',
      role: UserRole.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      emailVerified: new Date(),
    },
    update: { passwordHash, role: UserRole.SUPER_ADMIN, status: UserStatus.ACTIVE },
  });
  log(`Super admin: ${email}`);
  return user.id;
}

/** Inline fact token as stored in TipTap JSON — the BOUND mention kind. */
const factRef = (factKey: string) => ({ type: 'factRef', attrs: { factKey } });
const txt = (text: string) => ({ type: 'text', text });
const doc = (...inline: object[]) => ({ type: 'doc', content: [{ type: 'paragraph', content: inline }] });

async function seedDemoTenant(adminId: string, modelIds: Map<string, string>): Promise<void> {
  const tenant = await prisma.tenant.upsert({
    where: { slug: DEMO.tenantSlug },
    create: {
      name: 'Acme Cloud',
      slug: DEMO.tenantSlug,
      plan: TenantPlan.BUSINESS,
      quota: {
        sites: 10,
        pages: 5000,
        storageMb: 50_000,
        apiCallsPerMonth: 5_000_000,
        aiTokensPerMonth: 50_000_000,
        aiRequestsPerMin: 300,
        maxAgents: 20,
        vectorDimensions: 1536,
      },
      aiSettings: {
        defaultModel: 'anthropic/claude-sonnet-5-5',
        fallbackModels: ['anthropic/claude-haiku-5-5', 'openai/gpt-4o-mini', 'ollama/llama3.1:8b', 'ollama/qwen2.5vl:7b'],
        budgetUsd: 500,
        hardLimit: false,
        allowedModels: [],
        guardrailsPolicy: { piiRedaction: true, promptInjection: 'block' },
      },
    },
    update: {},
  });

  await prisma.tenantMember.upsert({
    where: { tenantId_userId: { tenantId: tenant.id, userId: adminId } },
    create: { tenantId: tenant.id, userId: adminId, role: MemberRole.OWNER, joinedAt: new Date() },
    update: {},
  });

  const site = await prisma.site.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: DEMO.siteSlug } },
    create: {
      tenantId: tenant.id,
      name: 'Acme Cloud',
      slug: DEMO.siteSlug,
      internalDomain: DEMO.internalDomain,
      description: 'Demo site for the Canon fact-graph walkthrough',
      defaultLocale: 'en',
      locales: ['en', 'de', 'es'],
      isPublished: true,
      publishedAt: new Date(),
      theme: { colors: { primary: '#4f46e5' }, font: 'Inter' },
      aiSettings: {
        brandVoice: 'Confident, plain-spoken, no hype. Short sentences.',
        glossary: [{ term: 'Pro plan', translations: { de: 'Pro-Tarif', es: 'plan Pro' } }],
        forbiddenTopics: ['competitor pricing', 'legal advice'],
      },
    },
    update: {},
  });

  // ── Canon graph ──────────────────────────────────────────────────────────
  const org = await prisma.kgEntity.upsert({
    where: { tenantId_type_canonicalName: { tenantId: tenant.id, type: 'organization', canonicalName: 'Acme Cloud' } },
    create: { tenantId: tenant.id, siteId: site.id, type: 'organization', canonicalName: 'Acme Cloud', aliases: ['Acme'] },
    update: {},
  });
  const proPlan = await prisma.kgEntity.upsert({
    where: { tenantId_type_canonicalName: { tenantId: tenant.id, type: 'plan', canonicalName: 'Pro plan' } },
    create: { tenantId: tenant.id, siteId: site.id, type: 'plan', canonicalName: 'Pro plan', aliases: ['Pro', 'Pro tier'] },
    update: {},
  });
  await prisma.factRelation.upsert({
    where: { fromEntityId_toEntityId_predicate: { fromEntityId: org.id, toEntityId: proPlan.id, predicate: 'offers' } },
    create: { tenantId: tenant.id, fromEntityId: org.id, toEntityId: proPlan.id, predicate: 'offers' },
    update: {},
  });

  const integrationsSource =
    (await prisma.factSource.findFirst({ where: { tenantId: tenant.id, name: 'Integrations directory' } })) ??
    (await prisma.factSource.create({
      data: {
        tenantId: tenant.id,
        kind: FactSourceKind.URL,
        name: 'Integrations directory',
        uri: 'https://acme-cloud.canon.localhost/integrations',
        selector: { css: '[data-integrations-count]' },
        checkIntervalSec: 86_400,
      },
    }));

  const facts = [
    {
      key: 'pro_plan.price',
      subjectId: proPlan.id,
      predicate: 'monthly_price',
      valueType: FactValueType.MONEY,
      value: { amount: 49, currency: 'USD', period: 'month' },
      displayValue: '$49/month',
    },
    {
      key: 'pro_plan.seats',
      subjectId: proPlan.id,
      predicate: 'included_seats',
      valueType: FactValueType.NUMBER,
      value: { value: 10 },
      displayValue: '10 seats',
    },
    {
      key: 'acme.integrations_count',
      subjectId: org.id,
      predicate: 'integrations_count',
      valueType: FactValueType.NUMBER,
      value: { value: 120 },
      displayValue: '120+',
      sourceId: integrationsSource.id,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  ];
  const factIds = new Map<string, string>();
  for (const f of facts) {
    const row = await prisma.fact.upsert({
      where: { tenantId_key: { tenantId: tenant.id, key: f.key } },
      create: { tenantId: tenant.id, siteId: site.id, ...f },
      update: {},
    });
    factIds.set(f.key, row.id);
    await prisma.factVersion.upsert({
      where: { factId_version: { factId: row.id, version: 1 } },
      create: {
        tenantId: tenant.id,
        factId: row.id,
        version: 1,
        value: f.value,
        displayValue: f.displayValue,
        origin: FactChangeOrigin.IMPORT,
        reason: 'Initial seed',
        changedById: adminId,
        validFrom: row.validFrom,
      },
      update: {},
    });
  }

  // ── Pages (EN + DE) ──────────────────────────────────────────────────────
  const pages = [
    {
      fullPath: '/',
      slug: '',
      title: 'Acme Cloud — ship faster',
      locale: 'en',
      content: {
        root: {
          id: 'root',
          type: 'section',
          props: {},
          children: [
            { id: 'hero-1', type: 'hero', props: { title: 'Ship faster with Acme Cloud', subtitle: 'Connect 120+ tools in minutes.', ctaLabel: 'Start free', ctaHref: '/signup' }, children: [] },
            { id: 'text-1', type: 'text', props: { doc: doc(txt('Pro costs '), factRef('pro_plan.price'), txt(' and includes '), factRef('pro_plan.seats'), txt('.')) }, children: [] },
          ],
        },
      },
    },
    {
      fullPath: '/faq',
      slug: 'faq',
      title: 'FAQ',
      locale: 'en',
      content: {
        root: {
          id: 'root',
          type: 'section',
          props: {},
          children: [
            {
              id: 'faq-1',
              type: 'faq',
              props: {
                items: [
                  // Deliberately stale: drives the Consistency Linter demo ($39 vs canonical $49).
                  { q: 'How much is Pro?', a: 'The Pro plan is just $39 per month — less than a team lunch.' },
                  { q: 'How many integrations?', a: 'We integrate with 120+ apps out of the box.' },
                ],
              },
              children: [],
            },
          ],
        },
      },
    },
    {
      fullPath: '/',
      slug: '',
      title: 'Acme Cloud — schneller liefern',
      locale: 'de',
      content: {
        root: {
          id: 'root',
          type: 'section',
          props: {},
          children: [
            { id: 'text-1', type: 'text', props: { doc: doc(txt('Der Pro-Tarif kostet 49 $ pro Monat und enthält 10 Plätze.')) }, children: [] },
          ],
        },
      },
    },
  ];

  const translationGroupId = `tg_home_${site.id}`;
  const pageIds = new Map<string, string>();
  for (const p of pages) {
    const existing = await prisma.page.findFirst({
      where: { siteId: site.id, fullPath: p.fullPath, locale: p.locale, deletedAt: null },
    });
    const page =
      existing ??
      (await prisma.page.create({
        data: {
          tenantId: tenant.id,
          siteId: site.id,
          slug: p.slug,
          fullPath: p.fullPath,
          title: p.title,
          locale: p.locale,
          content: p.content,
          status: ContentStatus.PUBLISHED,
          publishedVersion: 1,
          publishedAt: new Date(),
          translationGroupId: p.fullPath === '/' ? translationGroupId : null,
          createdById: adminId,
          updatedById: adminId,
          versions: { create: { tenantId: tenant.id, version: 1, content: p.content, comment: 'Seed', createdById: adminId } },
        },
      }));
    pageIds.set(`${p.locale}:${p.fullPath}`, page.id);
  }

  // ── Mentions: one BOUND, one DETECTED-in-sync, one CONFLICT, one cross-locale ──
  const priceId = factIds.get('pro_plan.price')!;
  const integrationsId = factIds.get('acme.integrations_count')!;
  const mentions: Prisma.FactMentionCreateManyInput[] = [
    {
      tenantId: tenant.id, factId: priceId, entityType: ContentEntityType.PAGE, entityId: pageIds.get('en:/')!,
      locale: 'en', blockId: 'text-1', fieldPath: 'root.children[1].props.doc', anchor: { token: 'pro_plan.price' },
      surfaceText: '{{fact:pro_plan.price}}', kind: MentionKind.BOUND, state: MentionState.IN_SYNC, factVersionSeen: 1,
    },
    {
      tenantId: tenant.id, factId: priceId, entityType: ContentEntityType.PAGE, entityId: pageIds.get('en:/faq')!,
      locale: 'en', blockId: 'faq-1', fieldPath: 'root.children[0].props.items[0].a',
      anchor: { quote: { prefix: 'The Pro plan is just ', exact: '$39 per month', suffix: ' — less than' } },
      surfaceText: '$39 per month', observedValue: { amount: 39, currency: 'USD', period: 'month' },
      kind: MentionKind.DETECTED, state: MentionState.CONFLICT, confidence: 0.97, factVersionSeen: 1,
    },
    {
      tenantId: tenant.id, factId: priceId, entityType: ContentEntityType.PAGE, entityId: pageIds.get('de:/')!,
      locale: 'de', blockId: 'text-1', fieldPath: 'root.children[0].props.doc',
      anchor: { quote: { prefix: 'Der Pro-Tarif kostet ', exact: '49 $ pro Monat', suffix: ' und enthält' } },
      surfaceText: '49 $ pro Monat', observedValue: { amount: 49, currency: 'USD', period: 'month' },
      kind: MentionKind.DETECTED, state: MentionState.IN_SYNC, confidence: 0.95, factVersionSeen: 1,
    },
    {
      tenantId: tenant.id, factId: integrationsId, entityType: ContentEntityType.PAGE, entityId: pageIds.get('en:/')!,
      locale: 'en', blockId: 'hero-1', fieldPath: 'root.children[0].props.subtitle',
      anchor: { quote: { prefix: 'Connect ', exact: '120+ tools', suffix: ' in minutes.' } },
      surfaceText: '120+ tools', observedValue: { value: 120 },
      kind: MentionKind.DETECTED, state: MentionState.IN_SYNC, confidence: 0.92, factVersionSeen: 1,
    },
  ];
  // Re-runnable: mentions are derived data, rebuilt wholesale for the demo pages.
  await prisma.factMention.deleteMany({ where: { tenantId: tenant.id, entityId: { in: [...pageIds.values()] } } });
  await prisma.factMention.createMany({ data: mentions });

  // ── Collection + entries ─────────────────────────────────────────────────
  const posts = await prisma.collection.upsert({
    where: { siteId_slug: { siteId: site.id, slug: 'posts' } },
    create: {
      tenantId: tenant.id,
      siteId: site.id,
      name: 'Blog posts',
      slug: 'posts',
      schema: [
        { name: 'title', type: 'text', required: true, localized: true },
        { name: 'excerpt', type: 'textarea', localized: true, ai: { autoSummary: true } },
        { name: 'body', type: 'richtext', localized: true },
        { name: 'tags', type: 'tags', ai: { autoTag: true } },
      ],
      aiSettings: { autoTag: true, autoSummary: true, autoTranslate: false, extractFacts: true },
    },
    update: {},
  });
  const entries = [
    { slug: 'launch-pro', data: { title: 'Introducing Pro', excerpt: 'Pro is here at $49/month.', tags: ['pricing', 'launch'] } },
    { slug: '120-integrations', data: { title: 'We now support 120 integrations', excerpt: 'From Slack to SAP.', tags: ['integrations'] } },
  ];
  for (const e of entries) {
    const exists = await prisma.entry.findFirst({ where: { collectionId: posts.id, slug: e.slug, locale: 'en', deletedAt: null } });
    if (!exists) {
      await prisma.entry.create({
        data: {
          tenantId: tenant.id, collectionId: posts.id, slug: e.slug, data: e.data, status: ContentStatus.PUBLISHED,
          publishedAt: new Date(), createdById: adminId, updatedById: adminId,
          versions: { create: { tenantId: tenant.id, version: 1, data: e.data, createdById: adminId } },
        },
      });
    }
  }

  // ── Agents ───────────────────────────────────────────────────────────────
  for (const a of AI_AGENTS) {
    const data = {
      type: a.type,
      systemPrompt: a.systemPrompt,
      tools: a.tools,
      modelId: modelIds.get(a.modelName) ?? null,
      config: { team: 'canon-propagation' },
    };
    await prisma.aiAgent.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: a.name } },
      create: { tenantId: tenant.id, name: a.name, createdById: adminId, ...data },
      update: data,
    });
  }

  log(`Demo tenant "${tenant.slug}" → site ${DEMO.internalDomain}: ${pages.length} pages, ${facts.length} facts, ${mentions.length} mentions, ${AI_AGENTS.length} agents`);
}

async function main(): Promise<void> {
  const modelIds = await seedAiRegistry();
  await seedBlocks();
  const adminId = await seedAdmin();
  await seedDemoTenant(adminId, modelIds);
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`[seed] failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
