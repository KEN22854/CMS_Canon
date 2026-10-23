import type { AiAgentType, PrismaClient } from '@canon/db';

export type TeamRole = 'Strategist' | 'Copywriter' | 'Fact-Checker' | 'Translator';

/**
 * The propagation team. Same names/types as the seeded demo agents, so a tenant that customised
 * its agents in AI Studio keeps its prompts; missing members are created on first use.
 */
export const TEAM: Record<TeamRole, { type: AiAgentType; systemPrompt: string; tools: string[] }> = {
  Strategist: {
    type: 'CONTENT_STRATEGIST',
    tools: ['canon.impact_analysis', 'content.search', 'branch.create', 'team.assign'],
    systemPrompt:
      'You plan content changes. Given a fact change, run impact analysis, group affected spans by page and locale, decide which need AI rewrite vs. deterministic token update, open a branch and assign work to teammates. Pricing and legal pages always need human approval.',
  },
  Copywriter: {
    type: 'COPYWRITER',
    tools: ['canon.get_fact', 'content.read', 'branch.propose_change'],
    systemPrompt: 'You rewrite content spans so they state canonical facts, preserving brand voice, tone and length. You only touch the assigned spans and never introduce new claims.',
  },
  'Fact-Checker': {
    type: 'FACT_CHECKER',
    tools: ['canon.get_fact', 'canon.get_source', 'branch.review_change'],
    systemPrompt: 'You verify every proposed change in a branch against canonical facts and their sources. Reject any change that introduces an unsupported claim.',
  },
  Translator: {
    type: 'TRANSLATOR',
    tools: ['canon.get_fact', 'glossary.get', 'branch.propose_change'],
    systemPrompt: 'You align localized spans with the source-locale change, using the site glossary and keeping fact tokens intact.',
  },
};

type Db = Pick<PrismaClient, 'aiAgent'>;

export async function ensureTeam(db: Db, tenantId: string): Promise<Record<TeamRole, string>> {
  const out = {} as Record<TeamRole, string>;
  for (const [name, def] of Object.entries(TEAM) as [TeamRole, (typeof TEAM)[TeamRole]][]) {
    const agent = await db.aiAgent.upsert({
      where: { tenantId_name: { tenantId, name } },
      create: { tenantId, name, type: def.type, systemPrompt: def.systemPrompt, tools: def.tools, config: { team: 'canon-propagation' } },
      update: {},
      select: { id: true },
    });
    out[name] = agent.id;
  }
  return out;
}
