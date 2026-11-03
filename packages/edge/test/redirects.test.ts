import { describe, expect, it } from 'vitest';
import { findRedirectLoop, matchRedirect, normalizeRedirectPath, redirectIssue, type RedirectRule } from '../src';

const rules: RedirectRule[] = [
  { from: '/old-pricing', to: '/pricing', status: 301 },
  { from: '/blog/*', to: '/news/*', status: 301 },
  { from: '/blog/archive/*', to: 'https://archive.example.com/*', status: 302 },
  { from: '/docs/*', to: '/help', status: 308 },
];

describe('redirects', () => {
  it('normalizes paths', () => {
    expect(normalizeRedirectPath('/Old-Pricing/?utm=x#top')).toBe('/old-pricing');
    expect(normalizeRedirectPath('')).toBe('/');
  });

  it('matches exact rules first, then the longest prefix, and substitutes *', () => {
    expect(matchRedirect(rules, '/OLD-pricing/')).toEqual({ to: '/pricing', status: 301 });
    expect(matchRedirect(rules, '/blog/hello-world')).toEqual({ to: '/news/hello-world', status: 301 });
    expect(matchRedirect(rules, '/blog')).toEqual({ to: '/news', status: 301 });
    expect(matchRedirect(rules, '/blog/archive/2019/post')).toEqual({ to: 'https://archive.example.com/2019/post', status: 302 });
    expect(matchRedirect(rules, '/docs/a/b')).toEqual({ to: '/help', status: 308 });
    expect(matchRedirect(rules, '/blogger')).toBeNull();
    expect(matchRedirect(rules, '/pricing')).toBeNull();
  });

  it('validates rules and finds loops', () => {
    expect(redirectIssue('/a', '/b')).toBeNull();
    expect(redirectIssue('/', '/b')).toMatch(/home page/);
    expect(redirectIssue('/a', 'javascript:alert(1)')).toMatch(/Target/);
    expect(redirectIssue('/a', '//evil.example/x')).toMatch(/Target/);
    expect(redirectIssue('/a', '/b/*')).toMatch(/prefix/);
    expect(redirectIssue('/a', '/A/')).toMatch(/same/);
    expect(redirectIssue('/A b', '/b')).toMatch(/Source/);
    expect(findRedirectLoop([{ from: '/a', to: '/b', status: 301 }, { from: '/b', to: '/c', status: 301 }, { from: '/c', to: '/a', status: 301 }])).toEqual(['/a', '/b', '/c', '/a']);
    expect(findRedirectLoop(rules)).toBeNull();
  });
});
