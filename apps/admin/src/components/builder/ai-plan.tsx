'use client';

import { applyOperation, findNode, richTextToPlain, type BlockNode, type EditorOperation, type PageContent, type PlannedOperation, type RichTextDoc } from '@canon/blocks';
import { Check, Loader2, Wand2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useT, type MessageKey } from '@/lib/i18n';
import { cn, formatUsd } from '@/lib/utils';
import { Alert, Button } from '../ui';
import { useBlockLabels } from './labels';
import { useBuilder, useBuilderStore } from './store';

interface PlanResponse {
  summary: string;
  operations: PlannedOperation[];
  repaired: boolean;
  ai: { model: string; costUsd: number };
}

interface Diff {
  field: string;
  before: string;
  after: string;
}

const EXAMPLES: MessageKey[] = ['plan.example1', 'plan.example2', 'plan.example3'];

/**
 * Canon AI edits the page (Stage 5): the request goes to the planner with the current draft and
 * selection, the answer is a list of checked operations shown as a diff. The person keeps or drops
 * each one and applies the rest as one undoable edit. Rejected operations stay visible with the
 * reason, so it is clear what the model tried and why it was not allowed.
 */
export function AiPlanPanel({ siteId, pageId, locale }: { siteId: string; pageId: string; locale: string }) {
  const t = useT();
  const L = useBlockLabels();
  const store = useBuilderStore();
  const selectedIds = useBuilder((s) => s.selectedIds);
  const draftContent = useBuilder((s) => s.draft.content);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<{ res: PlanResponse; base: PageContent; keep: boolean[] } | null>(null);

  const ask = async () => {
    setBusy(true);
    try {
      const s = store.getState();
      const base = s.draft.content;
      const res = await api<PlanResponse>(`/sites/${siteId}/ai/plan`, { body: { instruction: instruction.trim(), content: base, selectedIds: s.selectedIds, locale, pageId } });
      setPlan({ res, base, keep: res.operations.map((o) => o.status === 'ok') });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Before/after per operation, computed on the page as it was when the plan was made.
  const details = useMemo(() => {
    if (!plan) return [];
    let content = plan.base;
    return plan.res.operations.map((o, i) => {
      if (o.status !== 'ok') return [];
      const diffs = describeDiff(o.operation, content.root, L);
      if (plan.keep[i]) content = applyOperation(content, o.operation);
      return diffs;
    });
  }, [plan, L]);

  const chosen = plan ? plan.res.operations.filter((o, i) => o.status === 'ok' && plan.keep[i]) : [];
  const apply = () => {
    if (!plan) return;
    const { applied, skipped } = store.getState().applyMany(chosen.map((o) => o.operation));
    toast.success(t('plan.applied', { count: applied }), {
      description: skipped ? t('plan.skipped', { count: skipped }) : undefined,
      action: { label: t('builder.undoAction'), onClick: () => store.temporal.getState().undo() },
    });
    setPlan(null);
    setInstruction('');
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <Wand2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div>
          <p className="text-sm font-semibold">{t('plan.title')}</p>
          <p className="text-xs text-muted-foreground">{t('plan.hint')}</p>
        </div>
      </div>
      <textarea
        rows={3}
        value={instruction}
        maxLength={2000}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && instruction.trim().length >= 3 && !busy && void ask()}
        placeholder={t('plan.placeholder')}
        aria-label={t('plan.instruction')}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      {!plan && (
        <div className="flex flex-wrap gap-1">
          {EXAMPLES.map((k) => (
            <button key={k} type="button" onClick={() => setInstruction(t(k))} className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-primary">
              {t(k)}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{selectedIds.length ? t('plan.scopeSelected', { count: selectedIds.length }) : t('plan.scopePage')}</span>
        <Button size="sm" loading={busy} disabled={instruction.trim().length < 3} onClick={() => void ask()}>
          {!busy && <Wand2 className="h-3.5 w-3.5" />} {t('plan.ask')}
        </Button>
      </div>

      {busy && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {t('plan.thinking')}
        </p>
      )}

      {plan && (
        <section aria-label={t('plan.result')} className="space-y-2 border-t pt-3">
          {plan.res.summary && <p className="text-sm">{plan.res.summary}</p>}
          <p className="text-[10px] text-muted-foreground">
            {plan.res.ai.model} · {formatUsd(plan.res.ai.costUsd)}
            {plan.res.repaired ? ` · ${t('plan.repaired')}` : ''}
          </p>
          {draftContent !== plan.base && <Alert className="text-xs">{t('plan.stale')}</Alert>}
          <ol className="space-y-1.5">
            {plan.res.operations.map((o, i) => {
              const ok = o.status === 'ok';
              const target = targetOf(o.operation);
              return (
                <li
                  key={i}
                  onMouseEnter={() => target && store.getState().hover(target)}
                  onMouseLeave={() => store.getState().hover(null)}
                  className={cn('rounded-md border p-2 text-xs', ok ? (plan.keep[i] ? 'border-primary/40 bg-primary/5' : 'opacity-60') : 'border-destructive/30 bg-destructive/5')}
                >
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-0.5" disabled={!ok} checked={ok && plan.keep[i]} onChange={(e) => setPlan({ ...plan, keep: plan.keep.map((k, j) => (j === i ? e.target.checked : k)) })} aria-label={opTitle(o, plan.base.root, L, t)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 font-medium">
                        <code className="rounded bg-muted px-1 font-mono text-[9px] text-muted-foreground">{o.operation.op}</code>
                        <span className="truncate">{opTitle(o, plan.base.root, L, t)}</span>
                      </span>
                      {ok ? (
                        <ul className="mt-1 space-y-0.5">
                          {details[i]?.map((d, k) => (
                            <li key={k} className="break-words text-muted-foreground">
                              <span className="font-medium text-foreground">{d.field}</span>: <del className="decoration-destructive/60">{d.before || '—'}</del> → <ins className="text-success no-underline">{d.after || '—'}</ins>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="mt-1 flex items-start gap-1 text-destructive">
                          <X className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> {t('plan.rejected')}: {o.reason}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ol>
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="ghost" onClick={() => setPlan(null)}>
              {t('plan.discard')}
            </Button>
            <Button size="sm" disabled={!chosen.length} onClick={apply}>
              <Check className="h-3.5 w-3.5" /> {t('plan.apply', { count: chosen.length })}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

type Labels = ReturnType<typeof useBlockLabels>;

function targetOf(op: EditorOperation): string | null {
  if ('id' in op) return op.id;
  if ('ids' in op) return op.ids[0] ?? null;
  if (op.op === 'NODE_INSERT') return op.parentId;
  return null;
}

function nameOf(root: BlockNode, id: string, L: Labels): string {
  const n = findNode(root, id);
  return n ? (n.name ?? L.name(n.type)) : id;
}

function opTitle(o: PlannedOperation, root: BlockNode, L: Labels, t: Labels['t']): string {
  const op = o.operation;
  const name =
    op.op === 'NODE_INSERT'
      ? op.nodes.map((n) => L.name(n.type)).join(', ')
      : 'ids' in op
        ? op.ids.length
          ? op.ids.map((id) => nameOf(root, id, L)).join(', ')
          : o.label
        : 'id' in op
          ? nameOf(root, op.id, L)
          : '';
  return t(`plan.op.${op.op}` as MessageKey, { name });
}

const show = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.length > 140 ? `${v.slice(0, 140)}…` : v;
  if (typeof v === 'object' && (v as { type?: string }).type === 'doc') return show(richTextToPlain(v as RichTextDoc));
  if (Array.isArray(v)) return `${v.length} ×`;
  return JSON.stringify(v).slice(0, 140);
};

function describeDiff(op: EditorOperation, root: BlockNode, L: Labels): Diff[] {
  switch (op.op) {
    case 'PROPS_UPDATE': {
      const n = findNode(root, op.id);
      return Object.entries(op.patch).map(([k, v]) => ({ field: n ? L.field(n.type, k) : k, before: show(n?.props[k]), after: show(v) }));
    }
    case 'STYLE_SET': {
      const n = findNode(root, op.id);
      return [{ field: `${L.t(`style.f.${op.property}` as MessageKey)} (${L.bp(op.breakpoint)})`, before: n?.styles?.[op.breakpoint]?.[op.property] ?? '', after: op.value ?? '' }];
    }
    case 'NODE_INSERT':
      return [{ field: nameOf(root, op.parentId, L), before: '', after: op.nodes.map((n) => `${L.name(n.type)}${show(n.props.title ?? n.props.text) ? ` “${show(n.props.title ?? n.props.text)}”` : ''}`).join(', ') }];
    case 'NODE_META':
      return Object.entries(op.patch).map(([k, v]) => ({ field: k, before: show(findNode(root, op.id)?.[k as 'name']), after: show(v) }));
    default:
      return [];
  }
}
