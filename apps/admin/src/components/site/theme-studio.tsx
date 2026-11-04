'use client';

import { onPrimaryChannels } from '@canon/ui-blocks';
import { THEME_CATEGORIES, THEME_FONTS, THEME_PRESETS, THEME_RADII, themeContrastIssues, themeTokens, type SiteThemeTokens, type ThemeCategory } from '@canon/blocks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Trash2 } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import { toast } from 'sonner';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { useLocale, useT, type MessageKey } from '@/lib/i18n';
import { useTenantId } from '@/lib/queries';
import { cn } from '@/lib/utils';

const FONT_CSS: Record<string, string> = { system: 'ui-sans-serif, system-ui, sans-serif', serif: 'ui-serif, Georgia, serif', mono: 'ui-monospace, monospace', Inter: 'Inter, ui-sans-serif, sans-serif', Manrope: 'Manrope, ui-sans-serif, sans-serif', Lora: 'Lora, ui-serif, Georgia, serif' };
const RADIUS_CSS: Record<string, string> = { none: '0', sm: '4px', md: '8px', lg: '14px', full: '9999px' };

function complete(raw: Partial<SiteThemeTokens> | undefined): SiteThemeTokens {
  const c = raw?.colors ?? ({} as Partial<SiteThemeTokens['colors']>);
  return { colors: { primary: c.primary ?? '#4f46e5', background: c.background ?? '#ffffff', foreground: c.foreground ?? '#0f172a', muted: c.muted ?? '#f1f5f9' }, font: raw?.font ?? 'system', radius: raw?.radius ?? 'md', mode: raw?.mode ?? 'auto' };
}
const same = (a: SiteThemeTokens, b: SiteThemeTokens) => JSON.stringify(themeTokens(a)) === JSON.stringify(themeTokens(b));

/** A small page fragment painted with a theme: heading, text, a button and a link on a band. */
function Swatch({ theme, big = false }: { theme: SiteThemeTokens; big?: boolean }) {
  const t = useT();
  const c = theme.colors;
  const style: CSSProperties = { background: c.background, color: c.foreground, fontFamily: FONT_CSS[theme.font] };
  return (
    <div style={style} className={cn('overflow-hidden rounded-md border', big ? 'p-6' : 'p-3')} aria-hidden>
      <p className={cn('font-bold leading-tight', big ? 'text-2xl' : 'text-sm')}>{t('theme.preview.title')}</p>
      {big && <p className="mt-2 text-sm opacity-80">{t('theme.preview.text')}</p>}
      <div className={cn('flex items-center gap-3', big ? 'mt-4' : 'mt-2')}>
        <span style={{ background: c.primary, color: `rgb(${onPrimaryChannels(c.primary)})`, borderRadius: RADIUS_CSS[theme.radius] }} className={cn('font-semibold', big ? 'px-4 py-2 text-sm' : 'px-2 py-0.5 text-[10px]')}>
          {t('theme.preview.button')}
        </span>
        <span style={{ color: c.primary }} className={cn('font-semibold', big ? 'text-sm' : 'text-[10px]')}>
          {t('theme.preview.link')} →
        </span>
      </div>
      <div style={{ background: c.muted, borderRadius: RADIUS_CSS[theme.radius] }} className={cn(big ? 'mt-4 h-8' : 'mt-2 h-2')} />
    </div>
  );
}

export function ThemeStudio({ siteId, theme: stored }: { siteId: string; theme: Partial<SiteThemeTokens> | undefined }) {
  const t = useT();
  const locale = useLocale();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const current = complete(stored);
  const [draft, setDraft] = useState<SiteThemeTokens>(current);
  const [cat, setCat] = useState<ThemeCategory | 'all'>('all');
  const dirty = !same(draft, current);
  const issues = themeContrastIssues(draft.colors);
  const ws = useQuery({ queryKey: ['themes', tid], queryFn: () => api<{ id: string; name: string; theme: SiteThemeTokens }[]>('/themes'), enabled: Boolean(tid) });
  const canEdit = ability.can('update', 'Site');

  const save = useMutation({
    mutationFn: () => api(`/sites/${siteId}/theme`, { method: 'PATCH', body: themeTokens(draft) }),
    onSuccess: () => (toast.success(t('theme.saved')), void qc.invalidateQueries({ queryKey: ['site', tid, siteId] })),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const saveWs = useMutation({
    mutationFn: (name: string) => api('/themes', { body: { name, theme: themeTokens(draft) } }),
    onSuccess: (_r, name) => (toast.success(t('theme.savedToWorkspace', { name })), void qc.invalidateQueries({ queryKey: ['themes', tid] })),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const dropWs = useMutation({
    mutationFn: (id: string) => api(`/themes/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['themes', tid] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const setColor = (k: keyof SiteThemeTokens['colors'], v: string) => setDraft({ ...draft, colors: { ...draft.colors, [k]: v } });
  const importJson = () => {
    const raw = window.prompt(t('theme.importPrompt'));
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<SiteThemeTokens>;
      const next = complete(parsed);
      const hex = /^#[0-9a-f]{6}$/i;
      if (!Object.values(next.colors).every((c) => hex.test(c)) || !THEME_FONTS.includes(next.font) || !THEME_RADII.includes(next.radius)) throw new Error('bad');
      setDraft(next);
    } catch {
      toast.error(t('theme.importBad'));
    }
  };
  const presets = THEME_PRESETS.filter((p) => cat === 'all' || p.category === cat);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('theme.title')}</CardTitle>
        <CardDescription>{t('theme.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Your theme: live preview + tokens. */}
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-2">
            <Swatch theme={draft} big />
            {issues.length > 0 && <p className="text-xs text-warning">{t('theme.contrast', { pairs: issues.map((i) => t(`theme.pair.${i.pair}` as MessageKey, { ratio: i.ratio, min: i.min })).join('; ') })}</p>}
          </div>
          <form
            className="space-y-3"
            aria-label={t('theme.yours')}
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="flex flex-wrap gap-4">
              {(
                [
                  ['primary', 'theme.primary'],
                  ['background', 'theme.background'],
                  ['foreground', 'theme.text'],
                  ['muted', 'theme.muted'],
                ] as const
              ).map(([k, label]) => (
                <div key={k} className="space-y-1.5">
                  <Label htmlFor={`th-${k}`}>{t(label)}</Label>
                  <input id={`th-${k}`} type="color" value={draft.colors[k]} disabled={!canEdit} onChange={(e) => setColor(k, e.target.value)} className="h-9 w-16 cursor-pointer rounded border" />
                </div>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="th-font">{t('theme.font')}</Label>
                <Select id="th-font" className="w-full" value={draft.font} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, font: e.target.value as SiteThemeTokens['font'] })}>
                  {THEME_FONTS.map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="th-radius">{t('theme.corners')}</Label>
                <Select id="th-radius" className="w-full" value={draft.radius} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, radius: e.target.value as SiteThemeTokens['radius'] })}>
                  {THEME_RADII.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="th-mode">{t('theme.mode')}</Label>
                <Select id="th-mode" className="w-full" value={draft.mode} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, mode: e.target.value as SiteThemeTokens['mode'] })}>
                  {(['light', 'dark', 'auto'] as const).map((m) => (
                    <option key={m} value={m}>
                      {t(`theme.mode.${m}`)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            {canEdit && (
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={!dirty} loading={save.isPending}>
                  {t('theme.save')}
                </Button>
                {dirty && <span className="text-xs text-warning">{t('theme.unsaved')}</span>}
                <Button type="button" variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(JSON.stringify(themeTokens(draft), null, 2)).then(() => toast.success(t('theme.exported')))}>
                  {t('theme.export')}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={importJson}>
                  {t('theme.import')}
                </Button>
              </div>
            )}
          </form>
        </div>

        {/* Gallery. */}
        <section aria-label={t('theme.gallery')} className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="mr-2 text-sm font-semibold">{t('theme.gallery')}</h3>
            {(['all', ...THEME_CATEGORIES] as const).map((c) => (
              <button key={c} type="button" aria-pressed={cat === c} onClick={() => setCat(c)} className={cn('rounded-full border px-2.5 py-0.5 text-xs', cat === c ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:border-primary')}>
                {t(`theme.cat.${c}` as MessageKey)}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {presets.map((p) => {
              const name = locale === 'ru' ? p.nameRu : p.name;
              const active = same(draft, p);
              return (
                <button key={p.key} type="button" disabled={!canEdit} aria-label={t('theme.use', { name })} aria-pressed={active} onClick={() => setDraft(themeTokens(p))} className={cn('rounded-lg border p-1.5 text-left transition hover:border-primary disabled:cursor-default', active && 'border-primary ring-2 ring-primary/30')}>
                  <Swatch theme={p} />
                  <span className="mt-1.5 flex items-center justify-between px-1 text-xs font-medium">
                    {name}
                    {same(current, p) && (
                      <span className="flex items-center gap-0.5 text-[10px] text-success">
                        <Check className="h-3 w-3" /> {t('theme.current')}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Workspace themes. */}
        <section aria-label={t('theme.workspace')} className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">{t('theme.workspace')}</h3>
              <p className="text-xs text-muted-foreground">{t('theme.workspaceHint')}</p>
            </div>
            {canEdit && (
              <Button size="sm" variant="outline" loading={saveWs.isPending} onClick={() => {
                const name = window.prompt(t('theme.namePrompt'))?.trim();
                if (name) saveWs.mutate(name.slice(0, 60));
              }}>
                {t('theme.saveToWorkspace')}
              </Button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {ws.data?.map((w) => (
              <div key={w.id} className={cn('rounded-lg border p-1.5', same(draft, w.theme) && 'border-primary')}>
                <button type="button" disabled={!canEdit} aria-label={t('theme.use', { name: w.name })} onClick={() => setDraft(complete(w.theme))} className="block w-full text-left">
                  <Swatch theme={complete(w.theme)} />
                </button>
                <span className="mt-1.5 flex items-center justify-between px-1 text-xs font-medium">
                  {w.name}
                  {canEdit && (
                    <button type="button" aria-label={t('theme.deleteWs', { name: w.name })} onClick={() => dropWs.mutate(w.id)} className="rounded p-0.5 text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
