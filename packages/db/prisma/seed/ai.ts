import { AiAgentType, AiFeature } from '@prisma/client';

/**
 * Model registry. Prices are USD per 1M tokens and are DATA, not code: update them here (or via
 * the admin UI in Phase 5) when providers change pricing. Anthropic prices verified 2026-10;
 * OpenAI/Google rows must be re-checked against their pricing pages before production billing.
 */
export const AI_PROVIDERS = [
  { name: 'anthropic', displayName: 'Anthropic' },
  { name: 'openai', displayName: 'OpenAI' },
  { name: 'google', displayName: 'Google Gemini' },
  { name: 'ollama', displayName: 'Ollama (local)', config: { apiEndpoint: 'http://localhost:11434' } },
] as const;

export interface SeedModel {
  provider: (typeof AI_PROVIDERS)[number]['name'];
  name: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputPricePer1M: number;
  outputPricePer1M: number;
  capabilities: string[];
  tier: 'economy' | 'standard' | 'premium' | 'local';
  embeddingDims?: number;
}

const CLAUDE_CAPS = ['text', 'vision', 'function-calling', 'json-mode'];

export const AI_MODELS: SeedModel[] = [
  { provider: 'anthropic', name: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000, inputPricePer1M: 4, outputPricePer1M: 20, capabilities: CLAUDE_CAPS, tier: 'premium' },
  { provider: 'anthropic', name: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000, inputPricePer1M: 2, outputPricePer1M: 10, capabilities: CLAUDE_CAPS, tier: 'standard' },
  { provider: 'anthropic', name: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000, inputPricePer1M: 0.1, outputPricePer1M: 0.5, capabilities: CLAUDE_CAPS, tier: 'economy' },
  { provider: 'openai', name: 'gpt-4o', displayName: 'GPT-4o', contextWindow: 128_000, maxOutputTokens: 16_384, inputPricePer1M: 2.5, outputPricePer1M: 10, capabilities: ['text', 'vision', 'function-calling', 'json-mode'], tier: 'standard' },
  { provider: 'openai', name: 'gpt-4o-mini', displayName: 'GPT-4o mini', contextWindow: 128_000, maxOutputTokens: 16_384, inputPricePer1M: 0.15, outputPricePer1M: 0.6, capabilities: ['text', 'vision', 'function-calling', 'json-mode'], tier: 'economy' },
  { provider: 'openai', name: 'text-embedding-3-small', displayName: 'text-embedding-3-small', contextWindow: 8_191, maxOutputTokens: 0, inputPricePer1M: 0.02, outputPricePer1M: 0, capabilities: ['embedding'], tier: 'economy', embeddingDims: 1536 },
  { provider: 'google', name: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', contextWindow: 1_000_000, maxOutputTokens: 65_536, inputPricePer1M: 0.3, outputPricePer1M: 2.5, capabilities: ['text', 'vision', 'function-calling', 'json-mode'], tier: 'economy' },
  { provider: 'google', name: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', contextWindow: 1_000_000, maxOutputTokens: 65_536, inputPricePer1M: 1.25, outputPricePer1M: 10, capabilities: ['text', 'vision', 'function-calling', 'json-mode'], tier: 'standard' },
  { provider: 'ollama', name: 'qwen2.5vl:7b', displayName: 'Qwen2.5-VL 7B (local, vision)', contextWindow: 128_000, maxOutputTokens: 8_192, inputPricePer1M: 0, outputPricePer1M: 0, capabilities: ['text', 'vision', 'json-mode'], tier: 'local' },
  { provider: 'ollama', name: 'llama3.1:8b', displayName: 'Llama 3.1 8B (local)', contextWindow: 128_000, maxOutputTokens: 8_192, inputPricePer1M: 0, outputPricePer1M: 0, capabilities: ['text', 'function-calling', 'json-mode'], tier: 'local' },
];

export interface SeedPrompt {
  name: string;
  feature: AiFeature;
  system: string;
  template: string;
  variables: string[];
  modelKey?: string;
}

/** Platform-default prompts (tenantId = NULL). Tenants override by inserting the same name. */
export const AI_PROMPTS: SeedPrompt[] = [
  {
    name: 'text.rewrite',
    feature: AiFeature.REWRITE,
    system:
      'You are an editor for {{siteName}}. Brand voice: {{brandVoice}}. Never invent facts, numbers or claims that are not in the input. Keep the language of the input. Return only the rewritten text.',
    template: 'Rewrite the text below. Goal: {{goal}}.\n\n<text>\n{{text}}\n</text>',
    variables: ['siteName', 'brandVoice', 'goal', 'text'],
    modelKey: 'anthropic/claude-haiku-5-5',
  },
  {
    name: 'text.translate',
    feature: AiFeature.TRANSLATE,
    system:
      'You are a professional localiser. Translate faithfully into {{targetLocale}}. Use the glossary verbatim where it applies. Preserve inline fact tokens like {{fact:key}} and any markup exactly. Return only the translation.',
    template: '<glossary>\n{{glossary}}\n</glossary>\n\n<text>\n{{text}}\n</text>',
    variables: ['targetLocale', 'glossary', 'text'],
    modelKey: 'anthropic/claude-sonnet-5-5',
  },
  {
    name: 'seo.meta',
    feature: AiFeature.SEO,
    system:
      'You are an SEO specialist. Produce JSON {"title": string ≤ 60 chars, "description": string ≤ 155 chars, "keywords": string[] ≤ 8}. Use only claims present in the page.',
    template: 'Page title: {{title}}\nLocale: {{locale}}\n\n<page>\n{{content}}\n</page>',
    variables: ['title', 'locale', 'content'],
    modelKey: 'anthropic/claude-haiku-5-5',
  },
  {
    name: 'media.alt_text',
    feature: AiFeature.ALT_TEXT,
    system:
      'Write concise, literal alt text (≤ 125 chars) for screen-reader users in {{locale}}. Describe what is visible; do not start with "Image of".',
    template: 'Context of the page where the image is used: {{context}}',
    variables: ['locale', 'context'],
    modelKey: 'anthropic/claude-haiku-5-5',
  },
  {
    name: 'text.summarize',
    feature: AiFeature.SUMMARIZE,
    system: 'Summarise for an internal editor in {{locale}}. Max {{maxWords}} words. No preamble.',
    template: '<content>\n{{content}}\n</content>',
    variables: ['locale', 'maxWords', 'content'],
    modelKey: 'anthropic/claude-haiku-5-5',
  },
  {
    name: 'canon.extract_facts',
    feature: AiFeature.FACT_EXTRACT,
    system: [
      'You extract verifiable factual claims from website content into a knowledge graph.',
      'A claim is a statement about a specific subject with a concrete value: a price, a number, a date, a name, a capability, a limit.',
      'Ignore opinions, marketing adjectives and hypotheticals.',
      'Resolve subjects against the known entities when they clearly match; otherwise propose a new entity.',
      'For every claim return the exact surface text span as it appears in the input (verbatim, so it can be located).',
      'Respond with JSON only: {"claims":[{"subject":{"entityId"?:string,"type":string,"name":string},"predicate":string,"valueType":"TEXT|NUMBER|MONEY|PERCENT|DATE|BOOLEAN|URL|LIST","value":object,"surfaceText":string,"matchesFactKey"?:string,"confidence":number}]}',
    ].join('\n'),
    template:
      '<known_entities>\n{{entities}}\n</known_entities>\n<known_facts>\n{{facts}}\n</known_facts>\n<content locale="{{locale}}">\n{{content}}\n</content>',
    variables: ['entities', 'facts', 'locale', 'content'],
    modelKey: 'anthropic/claude-haiku-5-5',
  },
  {
    name: 'canon.propagate_fact',
    feature: AiFeature.FACT_PROPAGATE,
    system: [
      'A canonical fact changed. Rewrite ONLY the given span so it states the new value, keeping the surrounding sentence grammatical and on-brand ({{brandVoice}}).',
      'Preserve tone, length (±15%), language ({{locale}}) and markup. If the span compares the value ("under $50"), rephrase the comparison so it stays true.',
      'If the span cannot be made true with a local edit, return {"action":"escalate","reason":string}.',
      'Otherwise return {"action":"replace","text":string,"explanation":string}.',
    ].join('\n'),
    template:
      'Fact: {{factKey}} ({{predicate}} of {{subject}})\nOld value: {{oldValue}}\nNew value: {{newValue}}\n\n<context_before>{{before}}</context_before>\n<span>{{span}}</span>\n<context_after>{{after}}</context_after>',
    variables: ['brandVoice', 'locale', 'factKey', 'predicate', 'subject', 'oldValue', 'newValue', 'before', 'span', 'after'],
    modelKey: 'anthropic/claude-sonnet-5-5',
  },
  {
    name: 'canon.fact_check',
    feature: AiFeature.FACT_CHECK,
    system:
      'You verify a proposed edit against the canonical fact and the source excerpt. Respond JSON {"verdict":"pass|fail|uncertain","issues":string[],"confidence":number}. Fail on any number, date or name that does not match the canonical value.',
    template: 'Canonical: {{fact}}\nSource excerpt: {{source}}\n\n<original>{{original}}</original>\n<proposed>{{proposed}}</proposed>',
    variables: ['fact', 'source', 'original', 'proposed'],
    modelKey: 'anthropic/claude-haiku-5-5',
  },
];

export interface SeedAgent {
  name: string;
  type: AiAgentType;
  modelName: string;
  tools: string[];
  systemPrompt: string;
}

/** Canon propagation team. Tool names are MCP-compatible and resolved by the Agent Runtime (Phase 5). */
export const AI_AGENTS: SeedAgent[] = [
  {
    name: 'Strategist',
    type: AiAgentType.CONTENT_STRATEGIST,
    modelName: 'claude-opus-5-5',
    tools: ['canon.impact_analysis', 'content.search', 'branch.create', 'team.assign'],
    systemPrompt:
      'You plan content changes. Given a fact change or a content goal, run impact analysis, group affected spans by page and locale, decide which need AI rewrite vs. deterministic token update, open a branch and assign work to teammates. Escalate legal/pricing pages for human approval.',
  },
  {
    name: 'Copywriter',
    type: AiAgentType.COPYWRITER,
    modelName: 'claude-sonnet-5-5',
    tools: ['canon.get_fact', 'content.read', 'branch.propose_change'],
    systemPrompt:
      'You rewrite content spans so they state canonical facts, preserving brand voice, tone and length. You only touch the assigned spans and never introduce new claims.',
  },
  {
    name: 'Fact-Checker',
    type: AiAgentType.FACT_CHECKER,
    modelName: 'claude-haiku-5-5',
    tools: ['canon.get_fact', 'canon.get_source', 'branch.review_change'],
    systemPrompt:
      'You verify every proposed change in a branch against canonical facts and their sources. Reject any change that introduces an unsupported claim.',
  },
  {
    name: 'Translator',
    type: AiAgentType.TRANSLATOR,
    modelName: 'claude-sonnet-5-5',
    tools: ['canon.get_fact', 'glossary.get', 'branch.propose_change'],
    systemPrompt:
      'You align localized spans with the source-locale change, using the site glossary and keeping fact tokens intact.',
  },
  {
    name: 'SEO',
    type: AiAgentType.SEO_SPECIALIST,
    modelName: 'claude-haiku-5-5',
    tools: ['content.read', 'seo.analyze', 'branch.propose_change'],
    systemPrompt:
      'You check that titles, meta descriptions and structured data on changed pages still reflect canonical facts and stay within length limits.',
  },
  {
    name: 'Designer',
    type: AiAgentType.DESIGNER,
    modelName: 'claude-sonnet-5-5',
    tools: ['blocks.list', 'page.read', 'branch.propose_change'],
    systemPrompt:
      'You adjust block layout when a content change breaks it (e.g. a longer price label overflowing a pricing card). You never change copy.',
  },
];
