'use client';

import { type FONT_FAMILIES, STYLE_BREAKPOINTS, STYLE_PROPS, THEME_COLORS, isValidStyleValue, resolveStyles, setStyle, styleSource, type BlockNode, type StyleGroup, type StyleProperty } from '@canon/blocks';
import { ChevronDown, Eye, EyeOff, RotateCcw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useBuilder } from './store';

type Field = { prop: StyleProperty; label: string; kind?: 'length' | 'select' | 'color' | 'text'; placeholder?: string; wide?: boolean };

const GROUPS: { id: StyleGroup; label: string; fields: Field[] }[] = [
  {
    id: 'layout',
    label: 'Layout',
    fields: [
      { prop: 'display', label: 'Display', kind: 'select' },
      { prop: 'flexDirection', label: 'Direction', kind: 'select' },
      { prop: 'justifyContent', label: 'Justify', kind: 'select' },
      { prop: 'alignItems', label: 'Align', kind: 'select' },
      { prop: 'flexWrap', label: 'Wrap', kind: 'select' },
      { prop: 'gap', label: 'Gap', placeholder: '16px' },
      { prop: 'gridTemplateColumns', label: 'Grid columns', kind: 'text', placeholder: 'repeat(auto-fit, minmax(240px, 1fr))', wide: true },
      { prop: 'gridColumn', label: 'Grid span', kind: 'text', placeholder: 'span 2' },
      { prop: 'flexGrow', label: 'Grow', kind: 'text', placeholder: '1' },
    ],
  },
  {
    id: 'spacing',
    label: 'Spacing',
    fields: [
      { prop: 'marginTop', label: 'Margin top' },
      { prop: 'marginBottom', label: 'Margin bottom' },
      { prop: 'marginLeft', label: 'Margin left' },
      { prop: 'marginRight', label: 'Margin right' },
      { prop: 'paddingTop', label: 'Padding top' },
      { prop: 'paddingBottom', label: 'Padding bottom' },
      { prop: 'paddingLeft', label: 'Padding left' },
      { prop: 'paddingRight', label: 'Padding right' },
    ],
  },
  {
    id: 'size',
    label: 'Size',
    fields: [
      { prop: 'width', label: 'Width' },
      { prop: 'height', label: 'Height' },
      { prop: 'minWidth', label: 'Min W' },
      { prop: 'maxWidth', label: 'Max W' },
      { prop: 'minHeight', label: 'Min H' },
      { prop: 'maxHeight', label: 'Max H' },
    ],
  },
  {
    id: 'typography',
    label: 'Typography',
    fields: [
      { prop: 'fontFamily', label: 'Font', kind: 'select' },
      { prop: 'fontWeight', label: 'Weight', kind: 'select' },
      { prop: 'fontSize', label: 'Size', placeholder: '18px' },
      { prop: 'lineHeight', label: 'Line height', placeholder: '1.5' },
      { prop: 'letterSpacing', label: 'Letter spacing', placeholder: '0.02em' },
      { prop: 'textAlign', label: 'Align', kind: 'select' },
      { prop: 'textTransform', label: 'Case', kind: 'select' },
      { prop: 'textDecoration', label: 'Decoration', kind: 'select' },
      { prop: 'color', label: 'Colour', kind: 'color', wide: true },
    ],
  },
  {
    id: 'background',
    label: 'Background',
    fields: [
      { prop: 'backgroundColor', label: 'Colour', kind: 'color', wide: true },
      { prop: 'backgroundImage', label: 'Gradient', kind: 'text', placeholder: 'linear-gradient(135deg, #8B7CFF, #42C8E8)', wide: true },
    ],
  },
  {
    id: 'border',
    label: 'Border',
    fields: [
      { prop: 'borderWidth', label: 'Width', placeholder: '1px' },
      { prop: 'borderStyle', label: 'Style', kind: 'select' },
      { prop: 'borderRadius', label: 'Radius', placeholder: '12px' },
      { prop: 'borderColor', label: 'Colour', kind: 'color', wide: true },
    ],
  },
  {
    id: 'effects',
    label: 'Effects',
    fields: [
      { prop: 'opacity', label: 'Opacity', kind: 'text', placeholder: '1' },
      { prop: 'overflow', label: 'Overflow', kind: 'select' },
      { prop: 'mixBlendMode', label: 'Blend', kind: 'select' },
      { prop: 'boxShadow', label: 'Shadow', kind: 'text', placeholder: '0 8px 24px -4px rgba(0,0,0,0.25)', wide: true },
      { prop: 'filter', label: 'Filter', kind: 'text', placeholder: 'blur(4px)', wide: true },
    ],
  },
  {
    id: 'position',
    label: 'Position',
    fields: [
      { prop: 'position', label: 'Position', kind: 'select' },
      { prop: 'zIndex', label: 'Z-index', kind: 'text', placeholder: '10' },
      { prop: 'top', label: 'Top' },
      { prop: 'right', label: 'Right' },
      { prop: 'bottom', label: 'Bottom' },
      { prop: 'left', label: 'Left' },
    ],
  },
  {
    id: 'transform',
    label: 'Transform',
    fields: [
      { prop: 'translateX', label: 'Move X' },
      { prop: 'translateY', label: 'Move Y' },
      { prop: 'rotate', label: 'Rotate', kind: 'text', placeholder: '0deg' },
      { prop: 'scale', label: 'Scale', kind: 'text', placeholder: '1' },
      { prop: 'skewX', label: 'Skew', kind: 'text', placeholder: '0deg' },
    ],
  },
];

const BP_LABEL = Object.fromEntries(STYLE_BREAKPOINTS.map((b) => [b.id, b.label])) as Record<string, string>;

/** Visual styles of the selected block at the breakpoint being edited. */
export function StylePanel({ node, readOnly }: { node: BlockNode; readOnly: boolean }) {
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
          Editing {bpInfo.label}
          {bpInfo.max !== null && <span className="font-normal text-muted-foreground"> · ≤ {bpInfo.max}px</span>}
        </p>
        <p className="text-muted-foreground">{bp === 'base' ? 'Applies to every screen unless a smaller breakpoint overrides it.' : `Applies to ${bpInfo.label} and smaller; desktop stays as it is.`}</p>
        {overrides > 0 && <p className="mt-1 text-primary">{overrides} override{overrides === 1 ? '' : 's'} on this breakpoint</p>}
      </div>

      <button
        type="button"
        disabled={readOnly}
        onClick={() => set('display', hiddenHere ? (own.display === 'none' ? undefined : 'block') : 'none')}
        className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
        aria-pressed={hiddenHere}
      >
        <span className="flex items-center gap-2">
          {hiddenHere ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          {hiddenHere ? `Hidden on ${bpInfo.label}` : `Visible on ${bpInfo.label}`}
        </span>
        <span className="text-xs text-muted-foreground">{hiddenHere ? 'Show' : 'Hide'}</span>
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
                {g.label}
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
  const id = `st-${nodeId}-${field.prop}`;
  const kind = field.kind ?? 'length';
  const hint = inherited !== undefined && source ? `Inherited from ${BP_LABEL[source]}` : undefined;
  const label = (
    <div className="flex min-h-5 items-center justify-between gap-1">
      <label htmlFor={id} className={cn('truncate text-[11px] text-muted-foreground', value !== undefined && 'font-medium text-primary')} title={hint}>
        {value !== undefined && <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-primary align-middle" aria-hidden />}
        {field.label}
      </label>
      {value !== undefined && !readOnly && (
        <button type="button" onClick={() => onChange(undefined)} aria-label={`Reset ${field.label}`} title="Reset to inherited value" className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
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
  useEffect(() => setDraft(value ?? ''), [value]);
  // A bare number in a length field means pixels, like design tools.
  const normalise = (v: string) => (/^-?\d+(\.\d+)?$/.test(v.trim()) && isValidStyleValue(prop, `${v.trim()}px`) && !isValidStyleValue(prop, v.trim()) ? `${v.trim()}px` : v.trim());
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
      onBlur={() => invalid && setDraft(value ?? '')}
      className={inputCls}
    />
  );
}

function SelectStyle({ id, prop, value, inherited, readOnly, onChange }: { id: string; prop: StyleProperty; value?: string; inherited?: string; readOnly: boolean; onChange: (v: string | undefined) => void }) {
  const options = (STYLE_PROPS[prop] as { options?: readonly string[] }).options ?? [];
  return (
    <select id={id} value={value ?? ''} disabled={readOnly} onChange={(e) => onChange(e.target.value || undefined)} className={inputCls}>
      <option value="">{inherited ? `${inherited} (inherited)` : '—'}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {prop === 'fontFamily' ? FONT_LABEL[o as keyof typeof FONT_FAMILIES] : o}
        </option>
      ))}
    </select>
  );
}

const FONT_LABEL: Record<keyof typeof FONT_FAMILIES, string> = { inherit: 'Inherit', site: 'Site font', sans: 'Sans-serif', serif: 'Serif', mono: 'Monospace' };
const TOKEN_LABEL: Record<(typeof THEME_COLORS)[number], string> = { primary: 'Primary', background: 'Background', foreground: 'Text', muted: 'Muted' };

/** Hex picker + free text (rgb/hsl/transparent) + the site's theme colours, which follow theme changes. */
function ColorStyle({ id, prop, value, inherited, readOnly, onChange }: { id: string; prop: StyleProperty; value?: string; inherited?: string; readOnly: boolean; onChange: (v: string | undefined) => void }) {
  const shown = value ?? inherited ?? '';
  const hex = /^#[0-9a-fA-F]{6}$/.test(shown) ? shown : '#000000';
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        <input type="color" aria-label="Pick colour" value={hex} disabled={readOnly} onChange={(e) => onChange(e.target.value)} className="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-input bg-background p-0.5 disabled:opacity-50" />
        <TextStyle id={id} prop={prop} value={value} placeholder={inherited ?? '#RRGGBB, rgb(), transparent'} readOnly={readOnly} onChange={onChange} />
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Theme colours">
        {THEME_COLORS.map((t) => (
          <TokenChip key={t} active={value === `token:${t}`} disabled={readOnly} onClick={() => onChange(`token:${t}`)}>
            <span className="h-2.5 w-2.5 rounded-full border border-border" style={{ background: `rgb(var(--site-${t}, 128 128 128))` }} aria-hidden />
            {TOKEN_LABEL[t]}
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
