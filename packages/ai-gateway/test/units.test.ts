import { describe, expect, it } from 'vitest';
import { costMicroUsd, exactCacheKey, parseModelKey, renderTemplate } from '../src';

describe('parseModelKey', () => {
  it('keeps colons in local model tags', () => {
    expect(parseModelKey('ollama/llama3.1:8b')).toEqual({ provider: 'ollama', name: 'llama3.1:8b' });
  });

  it('rejects unknown providers', () => {
    expect(() => parseModelKey('acme/gpt')).toThrow(/Invalid model key/);
  });
});

describe('costMicroUsd', () => {
  it('is exact integer arithmetic for whole-cent prices', () => {
    expect(costMicroUsd({ inputPricePer1M: 4, outputPricePer1M: 20 }, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(24_000_000);
  });

  it('rounds fractional micro-dollars up', () => {
    expect(costMicroUsd({ inputPricePer1M: 0.15, outputPricePer1M: 0 }, { inputTokens: 1, outputTokens: 0 })).toBe(1);
  });
});

describe('renderTemplate', () => {
  it('substitutes known variables and leaves fact tokens intact', () => {
    expect(renderTemplate('Hi {{name}}, price {{fact:pro_plan.price}} {{missing}}', { name: 'Ann' })).toBe(
      'Hi Ann, price {{fact:pro_plan.price}} {{missing}}',
    );
  });
});

describe('exactCacheKey', () => {
  const base = { model: 'anthropic/claude-haiku-5-5' as const, messages: [{ role: 'user' as const, content: 'x' }], maxTokens: 10, responseFormat: 'text' };

  it('differs per model', () => {
    expect(exactCacheKey(base)).not.toBe(exactCacheKey({ ...base, model: 'anthropic/claude-opus-5-5' }));
  });

  it('is stable for identical input', () => {
    expect(exactCacheKey(base)).toBe(exactCacheKey({ ...base }));
  });
});
