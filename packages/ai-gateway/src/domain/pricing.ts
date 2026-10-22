import type { ChatMessage, ModelInfo, TokenUsage } from './types';

/**
 * USD-per-1M-tokens × tokens = micro-USD exactly, so cost stays an integer.
 * Rounded up: under-billing a tenant by fractions across millions of calls is worse than a µ$ over.
 */
export function costMicroUsd(model: Pick<ModelInfo, 'inputPricePer1M' | 'outputPricePer1M'>, usage: TokenUsage): number {
  return Math.ceil(usage.inputTokens * model.inputPricePer1M + usage.outputTokens * model.outputPricePer1M);
}

export function microUsdToUsd(micro: number): number {
  return micro / 1_000_000;
}

/** ~4 chars/token for Latin text; only used for pre-flight quota checks, never for billing. */
export function estimateTokens(system: string | undefined, messages: readonly ChatMessage[]): number {
  let chars = system?.length ?? 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else for (const p of m.content) chars += p.type === 'text' ? p.text.length : 4_000; // images ≈ 1k tokens
  }
  return Math.ceil(chars / 4);
}
