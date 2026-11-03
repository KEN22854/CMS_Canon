/**
 * Site redirects, evaluated in the renderer's proxy before anything else (bots included, so search
 * engines follow moved pages). Rules are exact paths or a prefix ending in "/*"; a "*" in the
 * target receives the rest of the path. Exact rules win over prefixes, longer prefixes over shorter.
 */
export interface RedirectRule {
  from: string;
  to: string;
  status: 301 | 302 | 307 | 308;
}

export const REDIRECT_STATUSES = [301, 302, 307, 308] as const;

/** "/About/" → "/about"; query strings and fragments are not part of a rule. */
export function normalizeRedirectPath(p: string): string {
  const path = p.split(/[?#]/)[0]!.trim().toLowerCase();
  const clean = `/${path}`.replace(/\/+/g, '/').replace(/\/$/, '');
  return clean === '' ? '/' : clean;
}

const SOURCE_RE = /^\/[a-z0-9\-._~%/]*(\/\*)?$/;
/** A path on the same site, or an absolute http(s) URL. */
const TARGET_RE = /^(\/[A-Za-z0-9\-._~%/*?=&#]*|https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9\-._~%/*?=&#]*)?)$/;

export function redirectIssue(from: string, to: string): string | null {
  if (!SOURCE_RE.test(from)) return 'Source must be a path like /old-page or /blog/*';
  if (from === '/' || from === '/*') return 'The home page and the whole site cannot be redirected';
  if (!TARGET_RE.test(to)) return 'Target must be a path (/new-page) or an http(s) URL';
  // "//host" is a path to the regex but another site to the browser.
  if (to.startsWith('//')) return 'Target must be a path (/new-page) or an http(s) URL';
  if (to.includes('*') && !from.endsWith('/*')) return 'Only a prefix rule (/old/*) can use * in the target';
  if (!from.endsWith('/*') && normalizeRedirectPath(to) === from) return 'Source and target are the same';
  return null;
}

/**
 * Finds the rule for a request path and builds the target. `null` when nothing matches or the
 * result would point back at the same path.
 */
export function matchRedirect(rules: readonly RedirectRule[], rawPath: string): { to: string; status: number } | null {
  const path = normalizeRedirectPath(rawPath);
  let best: { rule: RedirectRule; rest: string } | null = null;
  for (const r of rules) {
    if (r.from === path) return finish({ rule: r, rest: '' }, path);
    if (r.from.endsWith('/*')) {
      const prefix = r.from.slice(0, -2);
      if ((path === prefix || path.startsWith(`${prefix}/`)) && (!best || prefix.length > best.rule.from.length - 2)) best = { rule: r, rest: path.slice(prefix.length).replace(/^\//, '') };
    }
  }
  return best ? finish(best, path) : null;
}

function finish({ rule, rest }: { rule: RedirectRule; rest: string }, path: string) {
  const to = rule.to.includes('*') ? rule.to.replace('*', rest).replace(/\/$/, '') || '/' : rule.to;
  if (to.startsWith('//')) return null; // never another host through a substituted path
  if (to.startsWith('/') && normalizeRedirectPath(to) === path) return null;
  return { to, status: rule.status };
}

/**
 * Cycles among exact rules (a → b → a). Checked when a rule is saved: a loop would make the
 * renderer bounce visitors until the browser gives up.
 */
export function findRedirectLoop(rules: readonly RedirectRule[]): string[] | null {
  const next = new Map(rules.filter((r) => !r.from.endsWith('/*') && r.to.startsWith('/')).map((r) => [r.from, normalizeRedirectPath(r.to)]));
  for (const start of next.keys()) {
    const seen = [start];
    let cur = next.get(start);
    while (cur !== undefined) {
      if (cur === start) return [...seen, start];
      if (seen.includes(cur) || seen.length > 20) break;
      seen.push(cur);
      cur = next.get(cur);
    }
  }
  return null;
}
