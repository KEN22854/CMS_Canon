'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useSite, type Site } from '@/lib/content';
import { useTenantId } from '@/lib/queries';

const FONTS = ['system', 'serif', 'mono', 'Inter', 'Manrope', 'Lora'];
const RADII = ['none', 'sm', 'md', 'lg', 'full'];

export default function SiteSettings() {
  const { siteId } = useParams<{ siteId: string }>();
  const site = useSite(siteId);
  if (!site.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="space-y-6">
      <General site={site.data} />
      <Theme site={site.data} />
      <AiSettings site={site.data} />
      <Danger site={site.data} />
    </div>
  );
}

function useSaver(siteId: string) {
  const qc = useQueryClient();
  const tid = useTenantId();
  return (path: string) =>
    useMutation({
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
  const save = useSaver(site.id)('');
  const [name, setName] = useState(site.name);
  const [description, setDescription] = useState(site.description ?? '');
  const [locales, setLocales] = useState(site.locales.join(', '));
  const [defaultLocale, setDefaultLocale] = useState(site.defaultLocale);
  const [domain, setDomain] = useState(site.domain ?? '');
  const [titleTemplate, setTitleTemplate] = useState(site.seoDefaults.titleTemplate ?? '');
  const list = locales.split(',').map((l) => l.trim()).filter(Boolean);
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
            save.mutate({ name, description: description || null, locales: list, defaultLocale, domain: domain || null, seoDefaults: { titleTemplate: titleTemplate || undefined } });
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
          <div className="md:col-span-2">
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </div>
        </form>
        {domain && <Alert className="mt-4">Point a CNAME for {domain} to {site.internalDomain}. Automatic TLS and ownership verification arrive with the edge setup.</Alert>}
      </CardContent>
    </Card>
  );
}

function Theme({ site }: { site: Site }) {
  const save = useSaver(site.id)('/theme');
  const c = site.theme.colors ?? {};
  const [primary, setPrimary] = useState(c.primary ?? '#4f46e5');
  const [background, setBackground] = useState(c.background ?? '#ffffff');
  const [foreground, setForeground] = useState(c.foreground ?? '#0f172a');
  const [font, setFont] = useState(site.theme.font ?? 'system');
  const [radius, setRadius] = useState(site.theme.radius ?? 'md');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Theme</CardTitle>
        <CardDescription>Design tokens applied to every page as CSS variables.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ colors: { primary, background, foreground }, font, radius });
          }}
        >
          {(
            [
              ['Primary', primary, setPrimary],
              ['Background', background, setBackground],
              ['Text', foreground, setForeground],
            ] as const
          ).map(([label, v, set]) => (
            <div key={label} className="space-y-1.5">
              <Label htmlFor={`c-${label}`}>{label}</Label>
              <input id={`c-${label}`} type="color" value={v} onChange={(e) => set(e.target.value)} className="h-9 w-16 cursor-pointer rounded border" />
            </div>
          ))}
          <div className="space-y-1.5">
            <Label htmlFor="t-font">Font</Label>
            <Select id="t-font" value={font} onChange={(e) => setFont(e.target.value)}>
              {FONTS.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-radius">Corners</Label>
            <Select id="t-radius" value={radius} onChange={(e) => setRadius(e.target.value)}>
              {RADII.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
          </div>
          <Button type="submit" loading={save.isPending}>
            Save theme
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function AiSettings({ site }: { site: Site }) {
  const save = useSaver(site.id)('/ai-settings');
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
