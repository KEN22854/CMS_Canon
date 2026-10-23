import { isModelKey } from '@canon/ai-gateway';
import { z } from 'zod';

const modelKey = z.string().refine(isModelKey, 'Use provider/model, e.g. anthropic/claude-haiku-5-5');

export const promptVersionBody = z.object({
  system: z.string().max(20_000),
  template: z.string().min(1).max(20_000),
  modelKey: modelKey.nullable().optional(),
  note: z.string().max(200).optional(),
});
export type PromptVersionBody = z.infer<typeof promptVersionBody>;

export const activateBody = z.object({ version: z.number().int().positive(), scope: z.enum(['tenant', 'global']).default('tenant') });

export const promptTestBody = z.object({
  variables: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  version: z.number().int().positive().optional(),
  scope: z.enum(['tenant', 'global']).optional(),
  model: modelKey.optional(),
});
export type PromptTestBody = z.infer<typeof promptTestBody>;

export const AGENT_TOOLS = ['canon.get_fact', 'canon.search_claims', 'canon.impact_analysis', 'content.search', 'content.read'] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

export const agentBody = z.object({
  name: z.string().trim().min(1).max(60),
  systemPrompt: z.string().trim().min(10).max(10_000),
  tools: z.array(z.enum(AGENT_TOOLS)).max(AGENT_TOOLS.length).default([]),
  modelKey: modelKey.nullable().optional(),
  isActive: z.boolean().default(true),
});
export type AgentBody = z.infer<typeof agentBody>;

export const runAgentBody = z.object({ input: z.string().trim().min(1).max(4_000), siteId: z.string().min(1), maxSteps: z.number().int().min(1).max(8).default(6) });
export type RunAgentBody = z.infer<typeof runAgentBody>;

export const playgroundBody = z.object({
  models: z.array(modelKey).min(1).max(3),
  system: z.string().max(20_000).optional(),
  prompt: z.string().min(1).max(30_000),
  maxTokens: z.number().int().min(16).max(4_000).default(800),
});
export type PlaygroundBody = z.infer<typeof playgroundBody>;
