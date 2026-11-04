'use client';

import type { SiteThemeTokens } from '@canon/blocks';
import { ThemeStudio } from '@/components/site/theme-studio';
import { TelegramCard } from '@/components/site/telegram-card';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, Loader2, TriangleAlert } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useSite, type Site } from '@/lib/content';
import { useTenantId } from '@/lib/queries';
import { useT, type MessageKey } from '@/lib/i18n';
import { relativeTime } from '@/lib/utils';


export default function SiteSettings() {
  const { siteId } = useParams<{ siteId: string }>();
  const site = useSite(siteId);
  if (!site.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="space-y-6">
      <General site={site.data} />
      {site.data.domain && <DomainCard site={site.data} />}
      <ThemeStudio siteId={site.data.id} theme={site.data.theme as Partial<SiteThemeTokens>} />
      <TelegramCard siteId={site.data.id} />
      <AiSettings site={site.data} />
      <Danger site={site.data} />
    </div>
  );
}

/** One PATCH mutation per settings form (a hook per call site, so hook order never depends on data). */
function useSaver(siteId: string, path: string) {
  const qc = useQueryClient();
  const tid = useTenantId();
  return useMutation({
      mutationFn: (body: object) => api(`/sites/${siteId}${path}`, { method: 'PATCH', body }),
      onSuccess: () => {
        toast.success('Saved — the live site refreshes within seconds');
        void qc.invalidateQueries({ queryKey: ['site', tid, siteId] });
        void qc.invalidateQueries({ queryKey: ['sites', tid] });
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
}

function General({ site }: { site: Site }) {
  const save = useSaver(site.id, '');
  const [name, setName] = useState(site.name);
  const [description, setDescription] = useState(site.description ?? '');
  const [locales, setLocales] = useState(site.locales.join(', '));
  const [defaultLocale, setDefaultLocale] = useState(site.defaultLocale);
  const [domain, setDomain] = useState(site.domain ?? '');
  const [titleTemplate, setTitleTemplate] = useState(site.seoDefaults.titleTemplate ?? '');
  const [requireReview, setRequireReview] = useState(site.requireReview);
  const t = useT();
  const list = locales
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
  useEffect(() => {
    if (list.length && !list.includes(defaultLocale)) setDefaultLocale(list[0]!);
  }, [list, defaultLocale]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>Free address: {site.internalDomain}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({
              name,
              description: description || null,
              locales: list,
              defaultLocale,
              domain: domain || null,
              requireReview,
              seoDefaults: { titleTemplate: titleTemplate || undefined },
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="s-name">Name</Label>
            <Input id="s-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-domain">Custom domain</Label>
            <Input id="s-domain" value={domain} placeholder="www.example.com" onChange={(e) => setDomain(e.target.value)} />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="s-desc">Description</Label>
            <Input id="s-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-locales">Locales</Label>
            <Input id="s-locales" value={locales} onChange={(e) => setLocales(e.target.value)} placeholder="en, de, es" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-default">Default locale</Label>
            <Select id="s-default" className="w-full" value={defaultLocale} onChange={(e) => setDefaultLocale(e.target.value)}>
              {list.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="s-tt">Title template</Label>
            <Input id="s-tt" value={titleTemplate} placeholder="%s · Acme" onChange={(e) => setTitleTemplate(e.target.value)} />
          </div>
          <label className="flex items-start gap-2 text-sm md:col-span-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={requireReview}
              onChange={(e) => setRequireReview(e.target.checked)}
            />
            <span>
              {t('review.requireLabel')}
              <span className="block text-xs text-muted-foreground">{t('review.requireHint')}</span>
            </span>
          </label>
          <div className="md:col-span-2">
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

interface DomainStatus {
  domain: string;
  status: Site['domainStatus'];
  verifiedAt: string | null;
  checkedAt: string | null;
  error: string | null;
  records: { type: string; name: string; value: string; purpose: string }[];
}

const DOMAIN_BADGE: Record<Site['domainStatus'], { label: MessageKey; className: string }> = {
  NONE: { label: 'domain.badge.NONE', className: '' },
  PENDING: {
    label: 'domain.badge.PENDING',
    className: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  },
  VERIFIED: {
    label: 'domain.badge.VERIFIED',
    className: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400',
  },
  FAILED: { label: 'domain.badge.FAILED', className: 'border-destructive/40 text-destructive' },
};

/** DNS instructions and verification for the custom domain; it is served only once proven. */
function DomainCard({ site }: { site: Site }) {
  const tid = useTenantId();
  const t = useT();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['domain', tid, site.id, site.domain],
    queryFn: () => api<DomainStatus>(`/sites/${site.id}/domain`),
    enabled: Boolean(tid),
  });
  const verify = useMutation({
    mutationFn: () => api<DomainStatus>(`/sites/${site.id}/domain/verify`, { method: 'POST', body: {} }),
    onSuccess: (d) => {
      qc.setQueryData(['domain', tid, site.id, site.domain], d);
      if (d.status === 'VERIFIED') {
        toast.success(t('domain.isLive', { domain: d.domain }));
        void qc.invalidateQueries({ queryKey: ['site', tid, site.id] });
      }
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const d = status.data;
  const badge = DOMAIN_BADGE[d?.status ?? site.domainStatus];
  const copy = (v: string) =>
    void navigator.clipboard.writeText(v).then(() => toast.success(t('common.copied')));
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            {site.domain} <Badge className={badge.className}>{t(badge.label)}</Badge>
          </CardTitle>
          <CardDescription>
            {d?.status === 'VERIFIED'
              ? t('domain.live', { domain: d.domain })
              : t('domain.pending', { internal: site.internalDomain })}
          </CardDescription>
        </div>
        {d && d.status !== 'VERIFIED' && (
          <Button loading={verify.isPending} onClick={() => verify.mutate()}>
            {t('domain.checkNow')}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {status.isPending && (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" />
        )}
        {d?.error && (
          <Alert tone={d.status === 'VERIFIED' ? undefined : 'error'} className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {d.error}
          </Alert>
        )}
        {d && (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('domain.type')}</th>
                  <th className="px-3 py-2 font-medium">{t('domain.name')}</th>
                  <th className="px-3 py-2 font-medium">{t('domain.value')}</th>
                </tr>
              </thead>
              <tbody>
                {d.records.map((r) => (
                  <tr key={r.type} className="border-b align-top last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{r.type}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => copy(r.name)}
                        className="flex items-center gap-1 break-all text-left font-mono text-xs hover:text-primary"
                        title={t('common.copy')}
                      >
                        {r.name} <Copy className="h-3 w-3 shrink-0" aria-hidden />
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => copy(r.value)}
                        className="flex items-center gap-1 break-all text-left font-mono text-xs hover:text-primary"
                        title={t('common.copy')}
                      >
                        {r.value} <Copy className="h-3 w-3 shrink-0" aria-hidden />
                      </button>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {t(`domain.purpose.${r.type}` as MessageKey) || r.purpose}
                      </p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d?.status === 'VERIFIED' && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden />{' '}
            {t('domain.verified', { when: d.verifiedAt ? relativeTime(d.verifiedAt) : '' })}
            {d.checkedAt ? t('domain.lastChecked', { when: relativeTime(d.checkedAt) }) : ''}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function AiSettings({ site }: { site: Site }) {
  const save = useSaver(site.id, '/ai-settings');
  const [brandVoice, setBrandVoice] = useState(site.aiSettings.brandVoice ?? '');
  const [forbidden, setForbidden] = useState((site.aiSettings.forbiddenTopics ?? []).join(', '));
  const [glossary, setGlossary] = useState(
    (site.aiSettings.glossary ?? []).map((g) => [g.term, ...Object.entries(glossaryTranslations(g)).map(([l, t]) => `${l}=${t}`)].join(' | ')).join('\n'),
  );
  const parseGlossary = () =>
    glossary
      .split('\n')
      .map((line) => line.split('|').map((x) => x.trim()))
      .filter((parts) => parts[0])
      .map(([term, ...rest]) => ({ term: term!, translations: Object.fromEntries(rest.map((r) => r.split('=').map((x) => x.trim())).filter((kv) => kv.length === 2 && kv[0] && kv[1])) }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI</CardTitle>
        <CardDescription>Used by every AI feature on this site: rewrite, translate, SEO and agents.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ brandVoice, forbiddenTopics: forbidden.split(',').map((t) => t.trim()).filter(Boolean), glossary: parseGlossary() });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="ai-voice">Brand voice</Label>
            <textarea id="ai-voice" rows={3} value={brandVoice} onChange={(e) => setBrandVoice(e.target.value)} placeholder="Confident, plain-spoken, no hype. Short sentences." className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-glossary">Glossary (one term per line: term | de=… | es=…)</Label>
            <textarea id="ai-glossary" rows={4} value={glossary} onChange={(e) => setGlossary(e.target.value)} placeholder="Pro plan | de=Pro-Tarif | es=plan Pro" className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm" />
            <p className="text-[11px] text-muted-foreground">Terms without a translation for a locale are kept verbatim.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-forbidden">Forbidden topics</Label>
            <Input id="ai-forbidden" value={forbidden} onChange={(e) => setForbidden(e.target.value)} placeholder="competitor pricing, legal advice" />
          </div>
          <Button type="submit" loading={save.isPending}>
            Save AI settings
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Older sites store glossary entries flat ({term, de, es}); newer ones under `translations`. */
function glossaryTranslations(g: { term: string; translations?: Record<string, string> } & Record<string, unknown>): Record<string, string> {
  const { term: _term, translations, ...flat } = g;
  return Object.fromEntries(Object.entries({ ...flat, ...(translations ?? {}) }).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

function Danger({ site }: { site: Site }) {
  const router = useRouter();
  const qc = useQueryClient();
  const tid = useTenantId();
  const remove = useMutation({
    mutationFn: () => api(`/sites/${site.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sites', tid] });
      router.replace('/sites');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle>Delete site</CardTitle>
        <CardDescription>The site goes offline immediately. Pages and media are soft-deleted, so support can still restore them.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" loading={remove.isPending} onClick={() => window.prompt(`Type "${site.slug}" to delete this site`) === site.slug && remove.mutate()}>
          Delete {site.name}
        </Button>
      </CardContent>
    </Card>
  );
}
