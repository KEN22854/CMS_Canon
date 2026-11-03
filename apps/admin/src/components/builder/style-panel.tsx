'use client';

import { type FONT_FAMILIES, STYLE_BREAKPOINTS, STYLE_PROPS, THEME_COLORS, isValidStyleValue, resolveStyles, setStyle, styleSource, type BlockNode, type StyleGroup, type StyleProperty } from '@canon/blocks';
import { ChevronDown, Eye, EyeOff, RotateCcw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useT, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { AnimationPanel } from './animation-panel';
import { useBlockLabels } from './labels';
import { useBuilder } from './store';

type Field = { prop: StyleProperty; kind?: 'length' | 'select' | 'color' | 'text'; placeholder?: string; wide?: boolean };

const GROUPS: { id: StyleGroup; fields: Field[] }[] = [
  {
    id: 'layout',
    fields: [
      { prop: 'display', kind: 'select' },
      { prop: 'flexDirection', kind: 'select' },
      { prop: 'justifyContent', kind: 'select' },
      { prop: 'alignItems', kind: 'select' },
      { prop: 'flexWrap', kind: 'select' },
      { prop: 'gap', placeholder: '16px' },
      { prop: 'gridTemplateColumns', kind: 'text', placeholder: 'repeat(auto-fit, minmax(240px, 1fr))', wide: true },
      { prop: 'gridColumn', kind: 'text', placeholder: 'span 2' },
      { prop: 'flexGrow', kind: 'text', placeholder: '1' },
    ],
  },
  {
    id: 'spacing',
    fields: [
      { prop: 'marginTop' },
      { prop: 'marginBottom' },
      { prop: 'marginLeft' },
      { prop: 'marginRight' },
      { prop: 'paddingTop' },
      { prop: 'paddingBottom' },
      { prop: 'paddingLeft' },
      { prop: 'paddingRight' },
    ],
  },
  {
    id: 'size',
    fields: [
      { prop: 'width' },
      { prop: 'height' },
      { prop: 'minWidth' },
      { prop: 'maxWidth' },
      { prop: 'minHeight' },
      { prop: 'maxHeight' },
    ],
  },
  {
    id: 'typography',
    fields: [
      { prop: 'fontFamily', kind: 'select' },
      { prop: 'fontWeight', kind: 'select' },
      { prop: 'fontSize', placeholder: '18px' },
      { prop: 'lineHeight', placeholder: '1.5' },
      { prop: 'letterSpacing', placeholder: '0.02em' },
      { prop: 'textAlign', kind: 'select' },
      { prop: 'textTransform', kind: 'select' },
      { prop: 'textDecoration', kind: 'select' },
      { prop: 'color', kind: 'color', wide: true },
    ],
  },
  {
    id: 'background',
    fields: [
      { prop: 'backgroundColor', kind: 'color', wide: true },
      { prop: 'backgroundImage', kind: 'text', placeholder: 'linear-gradient(135deg, #8B7CFF, #42C8E8)', wide: true },
    ],
  },
  {
    id: 'border',
    fields: [
      { prop: 'borderWidth', placeholder: '1px' },
      { prop: 'borderStyle', kind: 'select' },
      { prop: 'borderRadius', placeholder: '12px' },
      { prop: 'borderColor', kind: 'color', wide: true },
    ],
  },
  {
    id: 'effects',
    fields: [
      { prop: 'opacity', kind: 'text', placeholder: '1' },
      { prop: 'overflow', kind: 'select' },
      { prop: 'mixBlendMode', kind: 'select' },
      { prop: 'boxShadow', kind: 'text', placeholder: '0 8px 24px -4px rgba(0,0,0,0.25)', wide: true },
      { prop: 'filter', kind: 'text', placeholder: 'blur(4px)', wide: true },
    ],
  },
  {
    id: 'position',
    fields: [
      { prop: 'position', kind: 'select' },
      { prop: 'zIndex', kind: 'text', placeholder: '10' },
      { prop: 'top' },
      { prop: 'right' },
      { prop: 'bottom' },
      { prop: 'left' },
    ],
  },
  {
    id: 'transform',
    fields: [
      { prop: 'translateX' },
      { prop: 'translateY' },
      { prop: 'rotate', kind: 'text', placeholder: '0deg' },
      { prop: 'scale', kind: 'text', placeholder: '1' },
      { prop: 'skewX', kind: 'text', placeholder: '0deg' },
    ],
  },
];

const fieldLabel = (prop: StyleProperty) => `style.f.${prop}` as MessageKey;

/** Visual styles of the selected block at the breakpoint being edited. */
export function StylePanel({ node, readOnly }: { node: BlockNode; readOnly: boolean }) {
  const t = useT();
  const { bp: bpName } = useBlockLabels();
  const bp = useBuilder((s) => s.breakpoint);
  const updateNode = useBuilder((s) => s.updateNode);
  const [open, setOpen] = useState<Set<StyleGroup>>(() => new Set(['layout', 'spacing', 'typography']));
  const effective = resolveStyles(node.styles, bp);
  const own = node.styles?.[bp] ?? {};
  const bpInfo = STYLE_BREAKPOINTS.find((b) => b.id === bp)!;
  const set = (prop: StyleProperty, value: string | undefined) => updateNode(node.id, { styles: setStyle(node.styles, bp, prop, value) }, `${node.id}.style.${bp}.${prop}`);
  const hiddenHere = effective.display === 'none';
  const overrides = Object.keys(own).length;

  return (
    <div className="space-y-3">
      <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
        <p className="font-medium">
          {t('style.editing', { bp: bpName(bp) })}
          {bpInfo.max !== null && <span className="font-normal text-muted-foreground"> · ≤ {bpInfo.max}px</span>}
        </p>
        <p className="text-muted-foreground">{bp === 'base' ? t('style.appliesAll') : t('style.appliesBp', { bp: bpName(bp) })}</p>
        {overrides > 0 && <p className="mt-1 text-primary">{t('style.overrides', { count: overrides })}</p>}
      </div>

      <AnimationPanel node={node} readOnly={readOnly} />

      <button
        type="button"
        disabled={readOnly}
        onClick={() => set('display', hiddenHere ? (own.display === 'none' ? undefined : 'block') : 'none')}
        className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
        aria-pressed={hiddenHere}
      >
        <span className="flex items-center gap-2">
          {hiddenHere ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          {hiddenHere ? t('style.hiddenOn', { bp: bpName(bp) }) : t('style.visibleOn', { bp: bpName(bp) })}
        </span>
        <span className="text-xs text-muted-foreground">{hiddenHere ? t('style.show') : t('style.hide')}</span>
      </button>

      {GROUPS.map((g) => {
        const isOpen = open.has(g.id);
        const count = g.fields.filter((f) => own[f.prop] !== undefined).length;
        return (
          <section key={g.id} className="rounded-md border">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen((o) => (o.has(g.id) ? (o.delete(g.id), new Set(o)) : new Set(o.add(g.id))))}
              className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium hover:bg-muted/60"
            >
              <span>
                {t(`style.g.${g.id}` as MessageKey)}
                {count > 0 && <span className="ml-1.5 rounded bg-primary/15 px-1 text-[10px] text-primary">{count}</span>}
              </span>
              <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', !isOpen && '-rotate-90')} />
            </button>
            {isOpen && (
              <div className="grid grid-cols-2 gap-x-2 gap-y-2.5 border-t px-3 py-3">
                {g.fields.map((f) => (
                  <StyleField
                    key={f.prop}
                    field={f}
                    nodeId={node.id}
                    value={own[f.prop]}
                    inherited={own[f.prop] === undefined ? effective[f.prop] : undefined}
                    source={styleSource(node.styles, bp, f.prop)}
                    readOnly={readOnly}
                    onChange={(v) => set(f.prop, v)}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function StyleField({ field, nodeId, value, inherited, source, readOnly, onChange }: { field: Field; nodeId: string; value?: string; inherited?: string; source: string | null; readOnly: boolean; onChange: (v: string | undefined) => void }) {
  const t = useT();
  const { bp } = useBlockLabels();
  const id = `st-${nodeId}-${field.prop}`;
  const name = t(fieldLabel(field.prop));
  const kind = field.kind ?? 'length';
  const hint = inherited !== undefined && source ? t('style.inheritedFrom', { bp: bp(source as Parameters<typeof bp>[0]) }) : undefined;
  const label = (
    <div className="flex min-h-5 items-center justify-between gap-1">
      <label htmlFor={id} className={cn('truncate text-[11px] text-muted-foreground', value !== undefined && 'font-medium text-primary')} title={hint}>
        {value !== undefined && <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-primary align-middle" aria-hidden />}
        {name}
      </label>
      {value !== undefined && !readOnly && (
        <button type="button" onClick={() => onChange(undefined)} aria-label={t('style.reset', { label: name })} title={t('style.resetHint')} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
          <RotateCcw className="h-3 w-3" />
        </button>
      )}
    </div>
  );
  return (
    <div className={cn('min-w-0 space-y-1', field.wide && 'col-span-2')}>
      {label}
      {kind === 'select' ? (
        <SelectStyle id={id} prop={field.prop} value={value} inherited={inherited} readOnly={readOnly} onChange={onChange} />
      ) : kind === 'color' ? (
        <ColorStyle id={id} prop={field.prop} value={value} inherited={inherited} readOnly={readOnly} onChange={onChange} />
      ) : (
        <TextStyle id={id} prop={field.prop} value={value} placeholder={inherited ?? field.placeholder} readOnly={readOnly} onChange={onChange} />
      )}
    </div>
  );
}

const inputCls = 'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs shadow-sm disabled:opacity-50 aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-destructive/40';

/** Free text with the property's grammar: invalid drafts stay local and are never applied. */
function TextStyle({ id, prop, value, placeholder, readOnly, onChange }: { id: string; prop: StyleProperty; value?: string; placeholder?: string; readOnly: boolean; onChange: (v: string | undefined) => void }) {
  const [draft, setDraft] = useState(value ?? '');
  // A bare number in a length field means pixels, like design tools.
  const normalise = (v: string) => (/^-?\d+(\.\d+)?$/.test(v.trim()) && isValidStyleValue(prop, `${v.trim()}px`) && !isValidStyleValue(prop, v.trim()) ? `${v.trim()}px` : v.trim());
  // Follow outside changes (undo, another breakpoint, a collaborator) but not our own echo: typing
  // "7" stores "7px", and rewriting the field to "7px" would turn the next keystroke into "7px7".
  useEffect(() => setDraft((d) => (normalise(d) === (value ?? '') ? d : (value ?? ''))), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const invalid = draft.trim() !== '' && !isValidStyleValue(prop, normalise(draft));
  return (
    <input
      id={id}
      value={draft}
      disabled={readOnly}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = normalise(e.target.value);
        if (v === '') onChange(undefined);
        else if (isValidStyleValue(prop, v)) onChange(v);
      }}
      // Leaving the field shows what is stored ("77" becomes "77px"; an invalid draft is dropped).
      onBlur={() => setDraft(value ?? '')}
      className={inputCls}
    />
  );
}

function SelectStyle({ id, prop, value, inherited, readOnly, onChange }: { id: string; prop: StyleProperty; value?: string; inherited?: string; readOnly: boolean; onChange: (v: string | undefined) => void }) {
  const t = useT();
  const options = (STYLE_PROPS[prop] as { options?: readonly string[] }).options ?? [];
  return (
    <select id={id} value={value ?? ''} disabled={readOnly} onChange={(e) => onChange(e.target.value || undefined)} className={inputCls}>
      <option value="">{inherited ? t('style.inherited', { value: prop === 'fontFamily' ? t(`style.font.${inherited}` as MessageKey) : inherited }) : '—'}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {prop === 'fontFamily' ? t(`style.font.${o as keyof typeof FONT_FAMILIES}`) : o}
        </option>
      ))}
    </select>
  );
}


/** Hex picker + free text (rgb/hsl/transparent) + the site's theme colours, which follow theme changes. */
function ColorStyle({ id, prop, value, inherited, readOnly, onChange }: { id: string; prop: StyleProperty; value?: string; inherited?: string; readOnly: boolean; onChange: (v: string | undefined) => void }) {
  const t = useT();
  const shown = value ?? inherited ?? '';
  const hex = /^#[0-9a-fA-F]{6}$/.test(shown) ? shown : '#000000';
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        <input type="color" aria-label={t('style.pickColour')} value={hex} disabled={readOnly} onChange={(e) => onChange(e.target.value)} className="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-input bg-background p-0.5 disabled:opacity-50" />
        <TextStyle id={id} prop={prop} value={value} placeholder={inherited ?? t('style.colourPlaceholder')} readOnly={readOnly} onChange={onChange} />
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={t('style.themeColours')}>
        {THEME_COLORS.map((c) => (
          <TokenChip key={c} active={value === `token:${c}`} disabled={readOnly} onClick={() => onChange(`token:${c}`)}>
            <span className="h-2.5 w-2.5 rounded-full border border-border" style={{ background: `rgb(var(--site-${c}, 128 128 128))` }} aria-hidden />
            {t(`style.token.${c}`)}
          </TokenChip>
        ))}
      </div>
    </div>
  );
}

function TokenChip({ active, disabled, onClick, children }: { active: boolean; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} aria-pressed={active} className={cn('flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted disabled:opacity-50', active && 'border-primary text-primary')}>
      {children}
    </button>
  );
}
