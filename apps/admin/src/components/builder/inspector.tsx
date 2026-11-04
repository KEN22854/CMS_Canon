'use client';

import { getBlock, type BlockNode, type FieldMeta, type RichTextDoc } from '@canon/blocks';
import { ArrowDown, ArrowUp, Plus, Trash2, Ungroup } from 'lucide-react';
import { Alert, Button, Input, Label, Select } from '../ui';
import { AiAssist } from '../editor/ai-assist';
import { MediaPicker } from '../editor/media-picker';
import { BlockAiMenu } from './block-ai';
import { ComponentInspector, MakeComponent } from './component-panel';
import { useBlockLabels } from './labels';
import { RichTextEditor } from './rich-text-editor';
import { useBuilder } from './store';
import { useForms } from '@/lib/forms';
import { useCollections } from '@/lib/collections';
import { useT } from '@/lib/i18n';

interface Ctx {
  siteId: string;
  pageId: string;
  readOnly: boolean;
  facts: Record<string, string>;
}

/** Form generated from the block definition's field metadata (the same registry the API validates with). */
export function Inspector({ node, ...ctx }: { node: BlockNode } & Ctx) {
  const updateProps = useBuilder((s) => s.updateProps);
  const ungroup = useBuilder((s) => s.ungroup);
  const L = useBlockLabels();
  const t = L.t;
  const def = getBlock(node.type);
  if (!def) return <Alert>{t('inspector.noEditor', { type: node.type })}</Alert>;
  if (node.type === 'component') return <ComponentInspector node={node} siteId={ctx.siteId} readOnly={ctx.readOnly} />;
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{L.name(node.type)}</p>
          <p className="text-xs text-muted-foreground">{L.description(node.type)}</p>
        </div>
        {!ctx.readOnly && <BlockAiMenu id={node.id} siteId={ctx.siteId} pageId={ctx.pageId} variant="inline" />}
      </div>
      {!ctx.readOnly && node.type === 'group' && node.children.length > 0 && (
        <Button size="sm" variant="outline" className="w-full" title={t('inspector.ungroupHint')} onClick={() => ungroup(node.id)}>
          <Ungroup className="h-3.5 w-3.5" /> {t('inspector.ungroup')}
        </Button>
      )}
      {Object.entries(def.fields).map(([prop, meta]) => (
        <Field
          key={`${node.id}-${prop}`}
          id={`${node.id}-${prop}`}
          blockId={node.id}
          prop={prop}
          meta={meta}
          label={L.field(node.type, prop)}
          itemLabel={(item) => L.item(node.type, prop, item)}
          value={node.props[prop] ?? (def.defaults() as Record<string, unknown>)[prop]}
          ctx={ctx}
          // Typing into one field coalesces into one undo step; switching fields starts a new one.
          onChange={(v) => updateProps(node.id, { [prop]: v }, `${node.id}.${prop}`)}
        />
      ))}
      {/* Not inside the component builder (pageId ''): components can't nest. */}
      {!ctx.readOnly && ctx.pageId && node.type !== 'column' && <MakeComponent node={node} siteId={ctx.siteId} />}
    </div>
  );
}

function Field({
  id,
  blockId,
  prop,
  meta,
  label: text,
  itemLabel,
  value,
  ctx,
  onChange,
}: {
  id: string;
  blockId: string;
  prop: string;
  meta: FieldMeta;
  label: string;
  itemLabel: (item: string) => string;
  value: unknown;
  ctx: Ctx;
  onChange: (v: unknown) => void;
}) {
  const label = (extra?: React.ReactNode) => (
    <div className="flex min-h-6 items-center justify-between">
      <Label htmlFor={id}>{text}</Label>
      {extra}
    </div>
  );
  const t = useT();
  const ai = (v: string) => (meta.ai && !ctx.readOnly ? <AiAssist value={v} onApply={onChange} siteId={ctx.siteId} pageId={ctx.pageId} /> : undefined);

  switch (meta.kind) {
    case 'text':
    case 'url': {
      const v = typeof value === 'string' ? value : '';
      return (
        <div className="space-y-1.5">
          {label(ai(v))}
          <Input id={id} value={v} disabled={ctx.readOnly} placeholder={meta.kind === 'url' ? t('inspector.urlPlaceholder') : undefined} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    }
    case 'textarea': {
      const v = typeof value === 'string' ? value : '';
      return (
        <div className="space-y-1.5">
          {label(ai(v))}
          <textarea id={id} rows={3} disabled={ctx.readOnly} value={v} onChange={(e) => onChange(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm" />
        </div>
      );
    }
    case 'richtext':
      return (
        <div className="space-y-1.5">
          {/* Rich text is rewritten server-side leaf by leaf, so formatting and facts survive. */}
          {label(!ctx.readOnly ? <BlockAiMenu id={blockId} siteId={ctx.siteId} pageId={ctx.pageId} variant="inline" fields={[prop]} /> : undefined)}
          <RichTextEditor id={id} value={value as RichTextDoc | undefined} onChange={onChange} readOnly={ctx.readOnly} siteId={ctx.siteId} facts={ctx.facts} />
          <p className="text-[11px] text-muted-foreground">{t('inspector.factHint')}</p>
        </div>
      );
    case 'select': {
      const v = value === undefined || value === null ? '' : String(value);
      return (
        <div className="space-y-1.5">
          {label()}
          <Select id={id} className="w-full" disabled={ctx.readOnly} value={v} onChange={(e) => onChange(/^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value)}>
            {meta.options?.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </div>
      );
    }
    case 'toggle':
      return (
        <label className="flex items-center gap-2 text-sm">
          <input
            id={id}
            type="checkbox"
            disabled={ctx.readOnly}
            checked={value !== false}
            onChange={(e) => onChange(e.target.checked)}
          />{' '}
          {text}
        </label>
      );
    case 'number': {
      const v = typeof value === 'number' ? String(value) : '';
      return (
        <div className="space-y-1.5">
          {label()}
          <Input id={id} type="number" inputMode="numeric" value={v} disabled={ctx.readOnly} onChange={(e) => e.target.value !== '' && Number.isFinite(Number(e.target.value)) && onChange(Number(e.target.value))} />
        </div>
      );
    }
    case 'collection':
      return (
        <div className="space-y-1.5">
          {label()}
          <CollectionPicker id={id} siteId={ctx.siteId} value={typeof value === 'string' ? value : ''} disabled={ctx.readOnly} onChange={onChange} />
        </div>
      );
    case 'form':
      return (
        <div className="space-y-1.5">
          {label()}
          <FormPicker
            id={id}
            siteId={ctx.siteId}
            value={typeof value === 'string' ? value : ''}
            disabled={ctx.readOnly}
            onChange={onChange}
          />
        </div>
      );
    case 'media':
      return (
        <div className="space-y-1.5">
          {label()}
          {ctx.readOnly ? <p className="text-xs text-muted-foreground">{typeof value === 'string' && value ? value : '—'}</p> : <MediaPicker siteId={ctx.siteId} value={typeof value === 'string' ? value : ''} onChange={onChange} />}
        </div>
      );
    case 'list':
      return <ListField id={id} meta={meta} label={text} itemLabel={itemLabel} value={value} ctx={ctx} onChange={onChange} />;
    default:
      return null;
  }
}

/** Repeating items (FAQ questions, feature cards, stats): edit, reorder, add and remove. */
function ListField({
  id,
  meta,
  label,
  itemLabel,
  value,
  ctx,
  onChange,
}: {
  id: string;
  meta: FieldMeta;
  label: string;
  itemLabel: (item: string) => string;
  value: unknown;
  ctx: Ctx;
  onChange: (v: unknown) => void;
}) {
  const t = useT();
  const items = (Array.isArray(value) ? value : []) as Record<string, unknown>[];
  const fields = Object.entries(meta.itemFields ?? {});
  const max = meta.maxItems ?? 20;
  const set = (next: Record<string, unknown>[]) => onChange(next);
  // Required item fields can't be empty on save, so new items start with their labels as text.
  const blank = () => Object.fromEntries(fields.map(([k]) => [k, itemLabel(k)]));
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 flex w-full items-center justify-between text-sm font-medium">
        {label}
        <span className="text-[11px] font-normal text-muted-foreground">
          {items.length}/{max}
        </span>
      </legend>
      {items.map((item, i) => (
        <div key={i} className="space-y-2 rounded-md border bg-muted/30 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">#{i + 1}</span>
            {!ctx.readOnly && (
              <span className="flex gap-0.5">
                <IconBtn label={t('inspector.moveUp')} disabled={i === 0} onClick={() => set(swap(items, i, i - 1))}>
                  <ArrowUp className="h-3 w-3" />
                </IconBtn>
                <IconBtn label={t('inspector.moveDown')} disabled={i === items.length - 1} onClick={() => set(swap(items, i, i + 1))}>
                  <ArrowDown className="h-3 w-3" />
                </IconBtn>
                <IconBtn label={t('inspector.remove')} onClick={() => set(items.filter((_, j) => j !== i))}>
                  <Trash2 className="h-3 w-3" />
                </IconBtn>
              </span>
            )}
          </div>
          {fields.map(([k, f]) => {
            const fl = itemLabel(k);
            const v = typeof item[k] === 'string' ? (item[k] as string) : '';
            const fid = `${id}-${i}-${k}`;
            const change = (nv: string) => set(items.map((it, j) => (j === i ? { ...it, [k]: nv } : it)));
            return (
              <div key={k} className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label htmlFor={fid} className="text-xs">
                    {fl}
                  </Label>
                  {f.ai && !ctx.readOnly && <AiAssist value={v} onApply={change} siteId={ctx.siteId} pageId={ctx.pageId} />}
                </div>
                {f.kind === 'textarea' ? (
                  <textarea id={fid} rows={2} disabled={ctx.readOnly} value={v} onChange={(e) => change(e.target.value)} className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm" />
                ) : (
                  <Input id={fid} value={v} disabled={ctx.readOnly} onChange={(e) => change(e.target.value)} className="h-8" />
                )}
              </div>
            );
          })}
        </div>
      ))}
      {!ctx.readOnly && items.length < max && (
        <Button type="button" size="sm" variant="outline" className="w-full" onClick={() => set([...items, blank()])}>
          <Plus className="h-3.5 w-3.5" /> {t('inspector.add')}
        </Button>
      )}
    </fieldset>
  );
}

function swap<T>(arr: T[], i: number, j: number): T[] {
  const next = [...arr];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="rounded p-1 hover:bg-muted disabled:opacity-30">
      {children}
    </button>
  );
}

/** Picks one of the site's forms; forms themselves are built under Site → Forms. */
function CollectionPicker({ id, siteId, value, disabled, onChange }: { id: string; siteId: string; value: string; disabled: boolean; onChange: (v: unknown) => void }) {
  const t = useT();
  const collections = useCollections(siteId);
  return (
    <div className="space-y-1">
      <Select id={id} className="w-full" disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('inspector.chooseCollection')}</option>
        {collections.data?.map((c) => (
          <option key={c.id} value={c.slug}>
            {c.name}
          </option>
        ))}
      </Select>
      {collections.data?.length === 0 && <p className="text-[11px] text-muted-foreground">{t('inspector.noCollections')}</p>}
    </div>
  );
}

function FormPicker({
  id,
  siteId,
  value,
  disabled,
  onChange,
}: {
  id: string;
  siteId: string;
  value: string;
  disabled: boolean;
  onChange: (v: unknown) => void;
}) {
  const t = useT();
  const forms = useForms(siteId);
  return (
    <div className="space-y-1">
      <Select
        id={id}
        className="w-full"
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t('inspector.chooseForm')}</option>
        {forms.data?.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
            {f.isActive ? '' : t('inspector.inactive')}
          </option>
        ))}
      </Select>
      <a
        href={value ? `/sites/${siteId}/forms/${value}` : `/sites/${siteId}/forms`}
        target="_blank"
        rel="noreferrer"
        className="text-[11px] text-primary hover:underline"
      >
        {value ? t('inspector.editForm') : t('inspector.createForm')}
      </a>
    </div>
  );
}
