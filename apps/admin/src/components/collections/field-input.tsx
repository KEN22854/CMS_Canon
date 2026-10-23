'use client';

import type { RichTextDoc } from '@canon/blocks';
import type { FieldDef } from '@canon/fields';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { RichTextEditor } from '../builder/rich-text-editor';
import { AiAssist } from '../editor/ai-assist';
import { MediaPicker } from '../editor/media-picker';
import { Input, Label, Select } from '../ui';
import { api } from '@/lib/api';
import { entriesPath, type EntryDetail, type EntryList } from '@/lib/collections';
import { cn } from '@/lib/utils';

export interface FieldCtx {
  siteId: string;
  entryId: string;
  readOnly: boolean;
  facts: Record<string, string>;
  related: EntryDetail['related'];
}

const area = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm disabled:opacity-60';

/** One input per field type, generated from the field definition — the "dynamic form". */
export function FieldInput({ field: f, value, error, onChange, ctx }: { field: FieldDef; value: unknown; error?: string; onChange: (v: unknown) => void; ctx: FieldCtx }) {
  const id = `fld-${f.name}`;
  const str = typeof value === 'string' ? value : '';
  const aiText = f.ai && !ctx.readOnly && (f.type === 'text' || f.type === 'textarea') ? <AiAssist value={str} onApply={onChange} siteId={ctx.siteId} pageId={ctx.entryId} /> : null;
  let input: React.ReactNode;
  switch (f.type) {
    case 'text':
    case 'email':
    case 'url':
      input = <Input id={id} type={f.type === 'text' ? 'text' : f.type} value={str} disabled={ctx.readOnly} maxLength={f.max} onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(error)} />;
      break;
    case 'textarea':
      input = <textarea id={id} rows={4} className={area} value={str} disabled={ctx.readOnly} maxLength={f.max} onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(error)} />;
      break;
    case 'richtext':
      input = <RichTextEditor id={id} value={value as RichTextDoc | undefined} onChange={onChange} readOnly={ctx.readOnly} siteId={ctx.siteId} facts={ctx.facts} />;
      break;
    case 'number':
      input = (
        <Input
          id={id}
          type="number"
          step={f.integer ? 1 : 'any'}
          min={f.min}
          max={f.max}
          disabled={ctx.readOnly}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          aria-invalid={Boolean(error)}
        />
      );
      break;
    case 'boolean':
      return (
        <label className="flex items-center gap-2 text-sm">
          <input id={id} type="checkbox" disabled={ctx.readOnly} checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {f.label}
          {f.helpText && <span className="text-xs text-muted-foreground">— {f.helpText}</span>}
        </label>
      );
    case 'date':
      input = <Input id={id} type="date" disabled={ctx.readOnly} value={str} onChange={(e) => onChange(e.target.value || undefined)} />;
      break;
    case 'datetime':
      // Stored as an ISO instant; edited in the browser's local time.
      input = <Input id={id} type="datetime-local" disabled={ctx.readOnly} value={str ? toLocalInput(str) : ''} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : undefined)} />;
      break;
    case 'select':
      input = f.multiple ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={`${id}-label`}>
          {f.options?.map((o) => {
            const list = Array.isArray(value) ? (value as string[]) : [];
            const on = list.includes(o);
            return (
              <button key={o} type="button" disabled={ctx.readOnly} aria-pressed={on} onClick={() => onChange(on ? list.filter((x) => x !== o) : [...list, o])} className={cn('rounded-full border px-2.5 py-1 text-xs', on ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground')}>
                {o}
              </button>
            );
          })}
        </div>
      ) : (
        <Select id={id} className="w-full" disabled={ctx.readOnly} value={str} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">—</option>
          {f.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
      break;
    case 'color':
      input = (
        <div className="flex items-center gap-2">
          <input type="color" aria-label={`${f.label} picker`} disabled={ctx.readOnly} value={/^#[0-9a-f]{6}$/i.test(str) ? str : '#000000'} onChange={(e) => onChange(e.target.value)} className="h-9 w-12 rounded border" />
          <Input id={id} className="w-32 font-mono" value={str} disabled={ctx.readOnly} onChange={(e) => onChange(e.target.value)} placeholder="#rrggbb" />
        </div>
      );
      break;
    case 'media':
      input = f.multiple ? <MediaList siteId={ctx.siteId} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} readOnly={ctx.readOnly} /> : <MediaPicker siteId={ctx.siteId} value={str} onChange={(v) => onChange(v || undefined)} />;
      break;
    case 'relation':
      input = <RelationPicker field={f} value={value} onChange={onChange} ctx={ctx} />;
      break;
    case 'json':
      input = <JsonInput id={id} value={value} onChange={onChange} readOnly={ctx.readOnly} />;
      break;
  }
  return (
    <div className="space-y-1.5">
      <div className="flex min-h-6 items-center justify-between">
        <Label htmlFor={id} id={`${id}-label`}>
          {f.label}
          {f.required && <span className="ml-0.5 text-destructive" title="Required to publish">*</span>}
        </Label>
        {aiText}
      </div>
      {input}
      {f.helpText && <p className="text-[11px] text-muted-foreground">{f.helpText}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function MediaList({ siteId, value, onChange, readOnly }: { siteId: string; value: string[]; onChange: (v: unknown) => void; readOnly: boolean }) {
  return (
    <div className="space-y-2">
      {value.map((id, i) => (
        <div key={id} className="flex items-start gap-2">
          <div className="flex-1">
            <MediaPicker siteId={siteId} value={id} onChange={(v) => onChange(v ? value.map((x, j) => (j === i ? v : x)) : value.filter((_, j) => j !== i))} />
          </div>
        </div>
      ))}
      {!readOnly && <MediaPicker siteId={siteId} value="" onChange={(v) => v && !value.includes(v) && onChange([...value, v])} />}
    </div>
  );
}

/** Searches the target collection; chosen entries are chips (title from the detail's related map). */
function RelationPicker({ field: f, value, onChange, ctx }: { field: FieldDef; value: unknown; onChange: (v: unknown) => void; ctx: FieldCtx }) {
  const ids = Array.isArray(value) ? (value as string[]) : typeof value === 'string' && value ? [value] : [];
  const target = f.relation?.collectionId ?? '';
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<EntryList['items']>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !target) return;
    const t = setTimeout(() => {
      void api<EntryList>(`${entriesPath(ctx.siteId, target)}?limit=10&sort=title&order=asc${q ? `&q=${encodeURIComponent(q)}` : ''}`).then((r) => setResults(r.items)).catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open, target, ctx.siteId]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const label = (id: string) => titles[id] ?? ctx.related[id]?.title ?? id;
  const pick = (e: EntryList['items'][number]) => {
    setTitles((t) => ({ ...t, [e.id]: e.title || e.slug }));
    if (f.multiple) onChange(ids.includes(e.id) ? ids : [...ids, e.id]);
    else onChange(e.id);
    setOpen(f.multiple);
    setQ('');
  };
  const removeId = (id: string) => onChange(f.multiple ? ids.filter((x) => x !== id) : undefined);

  return (
    <div className="relative space-y-1.5" ref={ref}>
      <div className="flex flex-wrap gap-1.5">
        {ids.map((id) => (
          <span key={id} className="inline-flex items-center gap-1 rounded-md border bg-muted/50 px-2 py-1 text-xs">
            {label(id)}
            {!ctx.readOnly && (
              <button type="button" aria-label={`Remove ${label(id)}`} onClick={() => removeId(id)} className="rounded hover:bg-muted">
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
      </div>
      {!ctx.readOnly && (f.multiple || ids.length === 0) && (
        <Input id={`fld-${f.name}`} value={q} placeholder="Search entries to link…" onFocus={() => setOpen(true)} onChange={(e) => (setQ(e.target.value), setOpen(true))} />
      )}
      {open && results.length > 0 && (
        <ul className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-card p-1 shadow-lg">
          {results.map((e) => (
            <li key={e.id}>
              <button type="button" onClick={() => pick(e)} disabled={ids.includes(e.id)} className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-40">
                <span className="truncate">{e.title || e.slug}</span>
                <span className="text-[10px] uppercase text-muted-foreground">{e.status.toLowerCase()}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function JsonInput({ id, value, onChange, readOnly }: { id: string; value: unknown; onChange: (v: unknown) => void; readOnly: boolean }) {
  const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
  const [bad, setBad] = useState(false);
  return (
    <>
      <textarea
        id={id}
        rows={6}
        className={cn(area, 'font-mono text-xs', bad && 'border-destructive')}
        disabled={readOnly}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) return (setBad(false), onChange(undefined));
          try {
            onChange(JSON.parse(e.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad && <p className="text-xs text-destructive">Not valid JSON yet — the last valid value is kept.</p>}
    </>
  );
}
