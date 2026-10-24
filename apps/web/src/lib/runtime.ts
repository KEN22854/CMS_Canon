import type { RuntimeConfig } from '@canon/edge';

/**
 * Per-site experiment/personalization config for the proxy, held in memory for a few seconds.
 * The proxy runs before every request, so it must never wait on the API twice per hit: a stale
 * entry is served while one refresh runs, and an unreachable API just means "no variants".
 */
const API = process.env.CANON_API_URL ?? 'http://localhost:4000';
const TTL_MS = 30_000;

interface HostInfo {
  id: string;
  defaultLocale: string;
  locales: string[];
}

interface Entry<T> {
  value: T | null;
  at: number;
  pending?: Promise<T | null>;
}

const hosts = new Map<string, Entry<HostInfo>>();
const configs = new Map<string, Entry<RuntimeConfig>>();

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}/v1/delivery${path}`, { headers: { 'x-canon-delivery': process.env.DELIVERY_TOKEN ?? '' }, cache: 'no-store', signal: AbortSignal.timeout(1_500) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

function cached<T>(map: Map<string, Entry<T>>, key: string, load: () => Promise<T | null>): Promise<T | null> {
  const e = map.get(key);
  const fresh = e && Date.now() - e.at < TTL_MS;
  if (e && fresh) return Promise.resolve(e.value);
  if (e?.pending) return e.value !== null ? Promise.resolve(e.value) : e.pending;
  const pending = load().then((value) => {
    map.set(key, { value, at: Date.now() });
    if (map.size > 5_000) map.delete(map.keys().next().value!);
    return value;
  });
  map.set(key, { value: e?.value ?? null, at: e?.at ?? 0, pending });
  // Stale-while-revalidate: answer with what we had, if anything.
  return e && e.value !== null ? Promise.resolve(e.value) : pending;
}

export function hostInfo(host: string): Promise<HostInfo | null> {
  return cached(hosts, host, () => fetchJson<HostInfo>(`/resolve?host=${encodeURIComponent(host)}`));
}

export function runtimeConfig(siteId: string): Promise<RuntimeConfig | null> {
  return cached(configs, siteId, () => fetchJson<RuntimeConfig>(`/sites/${siteId}/runtime`));
}
