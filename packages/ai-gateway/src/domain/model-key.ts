import type { ModelKey, ProviderId } from './types';

const PROVIDERS: ReadonlySet<string> = new Set<ProviderId>(['anthropic', 'openai', 'google', 'ollama']);

export function parseModelKey(key: string): { provider: ProviderId; name: string } {
  const slash = key.indexOf('/');
  const provider = key.slice(0, slash);
  const name = key.slice(slash + 1);
  if (slash <= 0 || !name || !PROVIDERS.has(provider)) {
    throw new Error(`Invalid model key "${key}" — expected "<provider>/<model>"`);
  }
  return { provider: provider as ProviderId, name };
}

export function isModelKey(key: string): key is ModelKey {
  try {
    parseModelKey(key);
    return true;
  } catch {
    return false;
  }
}

export function toModelKey(provider: ProviderId, name: string): ModelKey {
  return `${provider}/${name}`;
}
