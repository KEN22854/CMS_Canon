import { isModelKey, renderTemplate, type AiFeature, type ModelKey } from '@canon/ai-gateway';
import { Injectable } from '@nestjs/common';
import { notFound } from '../../../common/http/api-error';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

const TTL_MS = 60_000;

export interface ResolvedPrompt {
  id: string;
  name: string;
  version: number;
  feature: AiFeature;
  system: string;
  template: string;
  modelKey?: ModelKey;
}

/**
 * Versioned prompts from ai_prompts: a tenant override (same name) wins over the platform default,
 * and the highest active version wins within each. RLS lets a tenant read its own rows plus the
 * global ones (tenantId NULL), never another tenant's prompt engineering.
 */
@Injectable()
export class PromptRegistry {
  private readonly cache = new Map<string, { value: ResolvedPrompt; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async get(tenantId: string, name: string): Promise<ResolvedPrompt> {
    const key = `${tenantId}:${name}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

    const rows = await this.prisma.forTenant({ tenantId }).aiPrompt.findMany({
      where: { name, isActive: true, OR: [{ tenantId }, { tenantId: null }] },
      orderBy: [{ version: 'desc' }],
    });
    const row = rows.find((r) => r.tenantId === tenantId) ?? rows.find((r) => r.tenantId === null);
    if (!row) throw notFound(`Prompt "${name}"`);
    const value: ResolvedPrompt = {
      id: row.id,
      name: row.name,
      version: row.version,
      feature: row.feature,
      system: row.system ?? '',
      template: row.template,
      modelKey: row.modelKey && isModelKey(row.modelKey) ? row.modelKey : undefined,
    };
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  render(p: ResolvedPrompt, vars: Record<string, string | number>): { system: string; user: string } {
    return { system: renderTemplate(p.system, vars), user: renderTemplate(p.template, vars) };
  }
}
