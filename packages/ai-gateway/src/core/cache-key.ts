import { createHash } from 'node:crypto';
import type { ChatMessage, ModelKey } from '../domain/types';

/**
 * Deterministic key over everything that changes the answer. Model is part of the key: a cached
 * Haiku answer must not be served to a caller who explicitly asked for Opus.
 */
export function exactCacheKey(input: {
  model: ModelKey;
  system?: string;
  messages: readonly ChatMessage[];
  maxTokens: number;
  responseFormat: string;
  effort?: string;
}): string {
  const h = createHash('sha256');
  h.update(JSON.stringify([input.model, input.system ?? '', input.messages, input.maxTokens, input.responseFormat, input.effort ?? '']));
  return h.digest('hex');
}

/** Text used for semantic matching: the last user turn, which is what Q&A answers depend on. */
export function semanticQueryText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    return m.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ').trim();
  }
  return '';
}
