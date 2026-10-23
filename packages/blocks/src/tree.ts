import { z } from 'zod';
import { getBlock, type FieldMeta } from './definitions';
import { collectFactKeys, mapRichText, type RichTextDoc } from './rich-text';

export const MAX_DEPTH = 6;
export const MAX_NODES = 500;

export interface BlockNode {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children: BlockNode[];
}

export interface PageContent {
  root: BlockNode;
}

const nodeSchema: z.ZodType<BlockNode> = z.lazy(() =>
  z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    type: z.string().regex(/^[a-z0-9-]+(:[a-z0-9/_-]+)?$/).max(80),
    props: z.record(z.string(), z.unknown()).default({}),
    children: z.array(nodeSchema).max(200).default([]),
  }),
) as z.ZodType<BlockNode>;

export const pageContentSchema = z.object({ root: nodeSchema });

export interface TreeIssue {
  path: string;
  message: string;
}

export interface ValidateOptions {
  /** Types present in the DB registry (incl. plugins). Known MVP types are validated strictly. */
  registeredTypes?: ReadonlySet<string>;
  /** Containers per registry (for types without a local definition). */
  containerTypes?: ReadonlySet<string>;
}

/**
 * Structural + semantic validation of a page tree. Props of known blocks are parsed (and defaults
 * filled), so the stored tree is always renderer-safe; unknown-but-registered types pass through
 * untouched for forward compatibility with plugins and Phase 3 blocks.
 */
export function validatePageContent(input: unknown, opts: ValidateOptions = {}): { ok: true; content: PageContent } | { ok: false; issues: TreeIssue[] } {
  const parsed = pageContentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })) };
  }
  const issues: TreeIssue[] = [];
  const ids = new Set<string>();
  let count = 0;

  const walk = (node: BlockNode, path: string, depth: number, isRoot: boolean): BlockNode => {
    count += 1;
    if (ids.has(node.id)) issues.push({ path, message: `Duplicate block id "${node.id}"` });
    ids.add(node.id);
    if (depth > MAX_DEPTH) issues.push({ path, message: `Nesting deeper than ${MAX_DEPTH} levels` });

    const def = getBlock(node.type);
    if (!def && !opts.registeredTypes?.has(node.type)) issues.push({ path, message: `Unknown block type "${node.type}"` });
    const isContainer = def?.isContainer ?? opts.containerTypes?.has(node.type) ?? false;
    if (!isRoot && !isContainer && node.children.length > 0) issues.push({ path, message: `"${node.type}" cannot contain other blocks` });
    if (def?.allowedChildren) {
      for (const c of node.children) if (!def.allowedChildren.includes(c.type)) issues.push({ path, message: `"${node.type}" cannot contain "${c.type}"` });
    }

    let props = node.props;
    if (def) {
      const res = def.props.safeParse(node.props);
      if (res.success) props = res.data as Record<string, unknown>;
      else for (const i of res.error.issues.slice(0, 5)) issues.push({ path: `${path}.props.${i.path.join('.')}`, message: i.message });
    }
    return { ...node, props, children: node.children.map((c, i) => walk(c, `${path}.children[${i}]`, depth + 1, false)) };
  };

  const root = walk(parsed.data.root, 'root', 1, true);
  if (count > MAX_NODES) issues.push({ path: 'root', message: `More than ${MAX_NODES} blocks` });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, content: { root } };
}

export function emptyPageContent(): PageContent {
  return { root: { id: 'root', type: 'section', props: { background: 'default', paddingY: 'lg', width: 'default', anchor: '' }, children: [] } };
}

export interface TextField {
  blockId: string;
  prop: string;
  /** Set for fields inside list props (FAQ items, feature cards…). */
  item?: { index: number; prop: string };
  kind: 'plain' | 'rich';
  value: string | RichTextDoc;
}

type FieldRef = { blockId: string; prop: string; item?: { index: number; prop: string } };

/**
 * Walks the AI-editable fields of one block's props (including fields inside list items) and
 * rebuilds the props with the visitor's replacements. Collection and mapping share this walker,
 * so they can never disagree about which strings are translatable.
 */
function mapAiFields(
  blockId: string,
  props: Record<string, unknown>,
  fields: Record<string, FieldMeta>,
  visit: (value: string | RichTextDoc, kind: 'plain' | 'rich', ref: FieldRef) => string | RichTextDoc,
): Record<string, unknown> {
  const out = { ...props };
  for (const [prop, meta] of Object.entries(fields)) {
    const v = props[prop];
    if (meta.kind === 'list' && meta.itemFields && Array.isArray(v)) {
      out[prop] = v.map((item, index) => {
        if (!item || typeof item !== 'object') return item;
        const next = { ...(item as Record<string, unknown>) };
        for (const [ip, im] of Object.entries(meta.itemFields!)) {
          const iv = next[ip];
          if (im.ai && typeof iv === 'string' && iv.trim()) next[ip] = visit(iv, 'plain', { blockId, prop, item: { index, prop: ip } });
        }
        return next;
      });
      continue;
    }
    if (!meta.ai) continue;
    if (meta.kind === 'richtext' && v && typeof v === 'object') out[prop] = visit(v as RichTextDoc, 'rich', { blockId, prop });
    else if (typeof v === 'string' && v.trim()) out[prop] = visit(v, 'plain', { blockId, prop });
  }
  return out;
}

/** Every AI-editable text in the tree (per block definitions), in document order. */
export function collectTextFields(content: PageContent): TextField[] {
  const out: TextField[] = [];
  const walk = (n: BlockNode) => {
    const def = getBlock(n.type);
    if (def) mapAiFields(n.id, n.props, def.fields, (value, kind, ref) => (out.push({ ...ref, kind, value }), value));
    n.children.forEach(walk);
  };
  walk(content.root);
  return out;
}

/** Applies string replacements to plain fields and text leaves of rich fields; structure and facts are untouched. */
export function mapTextFields(content: PageContent, fn: (text: string, field: FieldRef) => string): PageContent {
  const walk = (n: BlockNode): BlockNode => {
    const def = getBlock(n.type);
    const props = def
      ? mapAiFields(n.id, n.props, def.fields, (value, kind, ref) => (kind === 'rich' ? mapRichText(value as RichTextDoc, (t) => fn(t, ref)) : fn(value as string, ref)))
      : n.props;
    return { ...n, props, children: n.children.map(walk) };
  };
  return { root: walk(content.root) };
}

/** Same, for one block's props (block-level AI actions in the builder). */
export function mapBlockText(node: BlockNode, fn: (text: string, field: FieldRef) => string): BlockNode {
  const def = getBlock(node.type);
  if (!def) return node;
  return { ...node, props: mapAiFields(node.id, node.props, def.fields, (value, kind, ref) => (kind === 'rich' ? mapRichText(value as RichTextDoc, (t) => fn(t, ref)) : fn(value as string, ref))) };
}

export function collectMediaIds(content: PageContent): string[] {
  const ids = new Set<string>();
  const walk = (n: BlockNode) => {
    const def = getBlock(n.type);
    if (def) for (const [prop, meta] of Object.entries(def.fields)) if (meta.kind === 'media' && typeof n.props[prop] === 'string' && n.props[prop]) ids.add(n.props[prop] as string);
    n.children.forEach(walk);
  };
  walk(content.root);
  return [...ids];
}

export function collectPageFactKeys(content: PageContent): string[] {
  const keys = new Set<string>();
  for (const f of collectTextFields(content)) if (f.kind === 'rich') collectFactKeys(f.value as RichTextDoc, keys);
  return [...keys];
}
