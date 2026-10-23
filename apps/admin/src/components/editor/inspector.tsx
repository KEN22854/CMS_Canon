'use client';

import { getBlock, type BlockNode, type FieldMeta, type RichTextDoc } from '@canon/blocks';
import { Alert, Input, Label, Select } from '../ui';
import { AiAssist } from './ai-assist';
import { MediaPicker } from './media-picker';
import { docToPlain, isSimpleDoc, plainToDoc } from './tree-ops';

interface Props {
  node: BlockNode;
  siteId: string;
  pageId: string;
  readOnly: boolean;
  onChange: (patch: Record<string, unknown>) => void;
}

/** Form generated from the block definition's field metadata (the same registry the API validates with). */
export function Inspector({ node, siteId, pageId, readOnly, onChange }: Props) {
  const def = getBlock(node.type);
  if (!def) return <Alert>“{node.type}” has no editor yet — it arrives with the page builder (Phase 3). Its content is kept as-is.</Alert>;
  return (
    <div className="space-y-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{def.name}</p>
      {Object.entries(def.fields).map(([prop, meta]) => (
        <Field key={prop} id={`${node.id}-${prop}`} meta={meta} value={node.props[prop]} readOnly={readOnly} siteId={siteId} pageId={pageId} onChange={(v) => onChange({ [prop]: v })} />
      ))}
    </div>
  );
}

function Field({ id, meta, value, readOnly, siteId, pageId, onChange }: { id: string; meta: FieldMeta; value: unknown; readOnly: boolean; siteId: string; pageId: string; onChange: (v: unknown) => void }) {
  const label = (extra?: React.ReactNode) => (
    <div className="flex items-center justify-between">
      <Label htmlFor={id}>{meta.label}</Label>
      {extra}
    </div>
  );
  switch (meta.kind) {
    case 'text':
    case 'url': {
      const v = typeof value === 'string' ? value : '';
      return (
        <div className="space-y-1.5">
          {label(meta.ai && !readOnly ? <AiAssist value={v} onApply={onChange} siteId={siteId} pageId={pageId} /> : undefined)}
          <Input id={id} value={v} disabled={readOnly} placeholder={meta.kind === 'url' ? '/contact or https://…' : undefined} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    }
    case 'textarea': {
      const v = typeof value === 'string' ? value : '';
      return (
        <div className="space-y-1.5">
          {label(meta.ai && !readOnly ? <AiAssist value={v} onApply={onChange} siteId={siteId} pageId={pageId} /> : undefined)}
          <textarea id={id} rows={3} disabled={readOnly} value={v} onChange={(e) => onChange(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm" />
        </div>
      );
    }
    case 'richtext': {
      const doc = value as RichTextDoc | undefined;
      if (!isSimpleDoc(doc)) {
        return (
          <div className="space-y-1.5">
            {label()}
            <Alert>This text has rich formatting; it can be edited in the full editor (Phase 3). It is preserved unchanged.</Alert>
          </div>
        );
      }
      const plain = doc ? docToPlain(doc) : '';
      return (
        <div className="space-y-1.5">
          {label(!readOnly ? <AiAssist value={plain} onApply={(t) => onChange(plainToDoc(t))} siteId={siteId} pageId={pageId} /> : undefined)}
          <textarea id={id} rows={8} disabled={readOnly} value={plain} onChange={(e) => onChange(plainToDoc(e.target.value))} className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-sm" />
          <p className="text-[11px] text-muted-foreground">Blank line = new paragraph. Insert a Canon fact as {'{{fact:pro_plan.price}}'} — it always renders the current value.</p>
        </div>
      );
    }
    case 'select': {
      const v = value === undefined || value === null ? '' : String(value);
      return (
        <div className="space-y-1.5">
          {label()}
          <Select id={id} className="w-full" disabled={readOnly} value={v} onChange={(e) => onChange(/^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value)}>
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
          <input id={id} type="checkbox" disabled={readOnly} checked={value !== false} onChange={(e) => onChange(e.target.checked)} /> {meta.label}
        </label>
      );
    case 'media':
      return (
        <div className="space-y-1.5">
          {label()}
          {readOnly ? <p className="text-xs text-muted-foreground">{typeof value === 'string' && value ? value : '—'}</p> : <MediaPicker siteId={siteId} value={typeof value === 'string' ? value : ''} onChange={onChange} />}
        </div>
      );
    default:
      return null;
  }
}
