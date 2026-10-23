import { useAuth, type AuthPayload } from './auth-store';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Multipart uploads; the browser sets the boundary header itself. */
  form?: FormData;
  /** Attach the in-memory access token and retry once through /auth/refresh on 401. */
  auth?: boolean;
}

const BASE = '/api/v1';

/**
 * The only HTTP client in the admin. Access tokens live in memory (never localStorage — XSS would
 * read it); the refresh token is an httpOnly cookie the browser sends to the same-origin proxy.
 */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const auth = opts.auth ?? true;
  const res = await send(path, opts, auth);
  if (res.status === 401 && auth && (await refreshSession())) {
    return parse<T>(await send(path, opts, auth));
  }
  if (res.status === 401 && auth) useAuth.getState().clear();
  return parse<T>(res);
}

function send(path: string, opts: RequestOptions, auth: boolean): Promise<Response> {
  const token = useAuth.getState().accessToken;
  return fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body === undefined && !opts.form ? 'GET' : 'POST'),
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    credentials: 'same-origin',
  });
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? res.statusText, err?.details);
  }
  return json as T;
}

let inflight: Promise<boolean> | null = null;

/** Single-flight: many parallel 401s trigger one refresh, not a rotation storm (→ reuse detection). */
export function refreshSession(): Promise<boolean> {
  inflight ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!res.ok) {
        useAuth.getState().clear();
        return false;
      }
      useAuth.getState().setSession((await res.json()) as AuthPayload);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (inflight = null), 0);
    }
  })();
  return inflight;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Please try again.';
}
