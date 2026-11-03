import { z } from 'zod';
import { materializeBlocks } from './catalog';
import { getBlock, NODE_ID_RE } from './definitions';
import { applyOperation, describeOperation, findNode, type EditorOperation } from './edit';
import { BREAKPOINT_IDS, isValidStyleValue, STYLE_PROPS, type StyleBreakpoint, type StyleProperty } from './styles';
import { validatePageContent, type BlockNode, type PageContent } from './tree';

/**
 * Canon AI edit plans (Stage 5). The model proposes edits to the current page as typed operations;
 * nothing it says is trusted. Each operation is shape-checked, new blocks are materialised (fresh
 * ids, facts bound), and operations are applied one by one to a working copy — one that doesn't
 * apply, or that leaves the page invalid, is rejected with a reason and the rest still go through.
 * The editor shows the result as a diff and the person approves operations individually.
 */

export const MAX_PLAN_OPERATIONS = 30;

const id = z.string().regex(NODE_ID_RE);
const rawNode = z.object({ type: z.string().max(40), props: z.record(z.string(), z.unknown()).optional(), children: z.array(z.unknown()).optional() }).passthrough();

/** What the model may send. Locking, replacing whole blocks and ungrouping stay human actions. */
const modelOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('NODE_INSERT'), parentId: id, index: z.number().int().min(0).max(10_000), nodes: z.array(rawNode).min(1).max(10) }),
  z.object({ op: z.literal('NODE_REMOVE'), ids: z.array(id).min(1).max(50) }),
  z.object({ op: z.literal('NODE_MOVE'), id, parentId: id, index: z.number().int().min(0).max(10_000) }),
  z.object({ op: z.literal('NODE_DUPLICATE'), id }),
  z.object({ op: z.literal('PROPS_UPDATE'), id, patch: z.record(z.string().max(64), z.unknown()) }),
  z.object({ op: z.literal('STYLE_SET'), id, breakpoint: z.enum(BREAKPOINT_IDS as [StyleBreakpoint, ...StyleBreakpoint[]]).default('base'), property: z.string().max(40), value: z.string().max(200).nullable() }),
  z.object({ op: z.literal('NODE_META'), id, patch: z.object({ name: z.string().max(60).optional(), hidden: z.boolean().optional() }) }),
  z.object({ op: z.literal('NODE_GROUP'), ids: z.array(id).min(1).max(50) }),
]);

export interface PlannedOperation {
  operation: EditorOperation;
  label: string;
  status: 'ok' | 'rejected';
  reason?: string;
}

export interface EditPlan {
  summary: string;
  operations: PlannedOperation[];
  /** The page with every accepted operation applied, in order. */
  content: PageContent;
}

export interface PlanOptions {
  facts?: Readonly<Record<string, string>>;
}

/** Turns the model's JSON into a checked plan against `content` (the page as the editor has it). */
export function buildPlan(raw: unknown, content: PageContent, opts: PlanOptions = {}): EditPlan {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as { summary?: unknown; operations?: unknown };
  const summary = typeof obj.summary === 'string' ? obj.summary.trim().slice(0, 500) : '';
  const items = Array.isArray(obj.operations) ? obj.operations.slice(0, MAX_PLAN_OPERATIONS) : [];
  const operations: PlannedOperation[] = [];
  let current = content;

  for (const item of items) {
    const parsed = modelOp.safeParse(item);
    const rawOp = (item && typeof item === 'object' ? (item as { op?: unknown }).op : undefined) as string | undefined;
    if (!parsed.success) {
      // Unparseable: nothing to apply or describe beyond the operation's name.
      operations.push({ operation: { op: 'NODE_REMOVE', ids: [] }, label: String(rawOp ?? 'Unknown operation').slice(0, 40), status: 'rejected', reason: parsed.error.issues[0]?.message ?? 'Invalid shape' });
      continue;
    }
    const prepared = prepare(parsed.data, current, opts);
    if ('reason' in prepared) {
      operations.push(rejected(prepared.op ?? (parsed.data as unknown as EditorOperation), prepared.reason, current));
      continue;
    }
    const next = applyOperation(current, prepared.op);
    if (next === current) {
      operations.push(rejected(prepared.op, 'Does not apply here (missing or locked block, or a nesting rule)', current));
      continue;
    }
    const check = validatePageContent(next);
    if (!check.ok) {
      operations.push(rejected(prepared.op, check.issues[0]?.message ?? 'Leaves the page invalid', current));
      continue;
    }
    operations.push({ operation: prepared.op, label: describeOperation(prepared.op, current.root), status: 'ok' });
    current = next;
  }
  return { summary, operations, content: current };
}

type ModelOp = z.infer<typeof modelOp>;

function prepare(op: ModelOp, content: PageContent, opts: PlanOptions): { op: EditorOperation } | { op?: EditorOperation; reason: string } {
  switch (op.op) {
    case 'NODE_INSERT': {
      // Materialised like generated blocks: fresh ids, coerced props, facts bound; bad ones dropped.
      const res = materializeBlocks(op.nodes, { facts: opts.facts });
      if (res.dropped.length) return { reason: `New block "${res.dropped[0]!.type}" is invalid: ${res.dropped[0]!.issues[0]?.message ?? ''}`.trim() };
      return { op: { op: 'NODE_INSERT', parentId: op.parentId, index: op.index, nodes: res.content.root.children } };
    }
    case 'PROPS_UPDATE': {
      const target = findNode(content.root, op.id);
      if (!target) return { reason: `No block "${op.id}" on the page` };
      const def = getBlock(target.type);
      const unknown = Object.keys(op.patch).filter((k) => !def?.fields[k]);
      if (unknown.length) return { reason: `"${target.type}" has no field ${unknown.map((k) => `"${k}"`).join(', ')}` };
      // Same path as generated blocks, so "doc" given as plain text becomes rich text and facts bind.
      const res = materializeBlocks([{ type: target.type, props: { ...target.props, ...op.patch } }], { facts: opts.facts });
      if (res.dropped.length) return { reason: res.dropped[0]!.issues[0]?.message ?? 'Invalid value' };
      const props = res.content.root.children[0]!.props;
      return { op: { op: 'PROPS_UPDATE', id: op.id, patch: Object.fromEntries(Object.keys(op.patch).map((k) => [k, props[k]])) } };
    }
    case 'STYLE_SET': {
      if (!(op.property in STYLE_PROPS)) return { reason: `Unknown style property "${op.property}"` };
      if (op.value !== null && !isValidStyleValue(op.property, op.value)) return { reason: `Invalid value for ${op.property}` };
      return { op: { op: 'STYLE_SET', id: op.id, breakpoint: op.breakpoint, property: op.property as StyleProperty, value: op.value } };
    }
    case 'NODE_META':
      return { op: { op: 'NODE_META', id: op.id, patch: op.patch } };
    default:
      return { op };
  }
}

function rejected(op: EditorOperation, reason: string, content: PageContent): PlannedOperation {
  return { operation: op, label: describeOperation(op, content.root), status: 'rejected', reason };
}

/**
 * The page as the model sees it: ids, types, names and the texts that identify a block, nested.
 * Compact on purpose (big pages must fit the prompt) — long texts are cut, media and rich-text
 * structure are left out.
 */
export function outlineForPlan(root: BlockNode, maxNodes = 400): string {
  const lines: string[] = [];
  let count = 0;
  const textOf = (n: BlockNode) => {
    const p = n.props;
    for (const k of ['title', 'text', 'label', 'quote', 'caption', 'name', 'buttonLabel', 'ctaLabel']) if (typeof p[k] === 'string' && p[k]) return String(p[k]).slice(0, 80);
    return '';
  };
  const walk = (n: BlockNode, depth: number) => {
    if (count++ >= maxNodes) return;
    const bits = [`${'  '.repeat(depth)}- ${n.id} ${n.type}`];
    if (n.name) bits.push(`"${n.name}"`);
    const t = textOf(n);
    if (t) bits.push(`: ${JSON.stringify(t)}`);
    if (n.locked) bits.push('(locked)');
    if (n.hidden) bits.push('(hidden)');
    lines.push(bits.join(' '));
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(root, 0);
  if (count > maxNodes) lines.push(`… ${count - maxNodes} more blocks not shown`);
  return lines.join('\n');
}

/** The operation vocabulary for the system prompt (kept next to the schema so they can't drift). */
export const PLAN_OPERATIONS_FOR_PROMPT = [
  '{"op":"PROPS_UPDATE","id":string,"patch":{field: value}} — change fields of a block (fields from the catalog; rich text "doc" may be given as plain text)',
  '{"op":"STYLE_SET","id":string,"breakpoint":"base"|"laptop"|"tablet"|"mobileL"|"mobileS","property":string,"value":string|null} — CSS-like style; base = all screens, smaller breakpoints override; null resets',
  '{"op":"NODE_INSERT","parentId":string,"index":number,"nodes":[{"type","props","children"?}]} — new blocks from the catalog (no ids)',
  '{"op":"NODE_REMOVE","ids":[string]}',
  '{"op":"NODE_MOVE","id":string,"parentId":string,"index":number}',
  '{"op":"NODE_DUPLICATE","id":string}',
  '{"op":"NODE_META","id":string,"patch":{"name"?:string,"hidden"?:boolean}}',
  '{"op":"NODE_GROUP","ids":[string]} — wrap sibling blocks in a Group',
].join('\n');

export const STYLE_PROPERTIES_FOR_PROMPT = Object.keys(STYLE_PROPS).join(', ');
