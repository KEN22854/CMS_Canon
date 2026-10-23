import { BLOCKS, getBlock, type BlockDefinition, type FieldMeta } from './definitions';
import { FACT_KEY_RE, type InlineNode } from './rich-text';
import { validatePageContent, type BlockNode, type PageContent, type TreeIssue } from './tree';

/**
 * Compact, model-readable description of the block registry. Generated from the same definitions
 * the API validates against, so prompts can't drift from what the server will accept.
 */
export function blockCatalogForPrompt(types: readonly string[] = BLOCKS.map((b) => b.type)): string {
  return types
    .map((t) => getBlock(t))
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
    .map((d) => {
      const props = Object.entries(d.fields).map(([name, f]) => `    ${name}: ${describeField(f)}`);
      const children = d.isContainer ? `\n  children: ${d.allowedChildren ? d.allowedChildren.join(' | ') + ' only' : 'any non-section blocks'}` : '';
      return `- ${d.type}: ${d.description}\n  props:\n${props.join('\n')}${children}\n  example props: ${JSON.stringify(d.defaults())}`;
    })
    .join('\n');
}

function describeField(f: FieldMeta): string {
  switch (f.kind) {
    case 'select':
      return `one of ${f.options?.map((o) => JSON.stringify(o)).join(', ')}`;
    case 'richtext':
      return 'rich text doc {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"…"}]}]} (paragraph/heading level 2-4/bulletList/orderedList/blockquote; marks bold/italic/link)';
    case 'list':
      return `array (max ${f.maxItems ?? 20}) of {${Object.entries(f.itemFields ?? {})
        .map(([k, v]) => `${k}: ${describeField(v)}`)
        .join(', ')}}`;
    case 'media':
      return 'media id string — leave "" (images are chosen by the editor)';
    case 'url':
      return 'relative path like "/contact" or https URL';
    case 'toggle':
      return 'boolean';
    default:
      return 'string';
  }
}

export interface MaterializeResult {
  content: PageContent;
  dropped: { index: number; type: string; issues: TreeIssue[] }[];
}

const newId = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

/**
 * Turns model output (blocks without trustworthy ids) into a valid tree. Each top-level block is
 * validated on its own so one hallucinated prop costs that block, not the whole page; ids are
 * always regenerated — model-provided ids could collide with existing ones.
 */
export interface MaterializeOptions {
  /** Known Canon facts (key → display value). {{fact:key}} tokens become bound factRefs in rich text. */
  facts?: Readonly<Record<string, string>>;
}

export function materializeBlocks(raw: unknown, opts: MaterializeOptions = {}): MaterializeResult {
  const items = Array.isArray(raw) ? raw : [];
  const kept: BlockNode[] = [];
  const dropped: MaterializeResult['dropped'] = [];
  items.forEach((item, index) => {
    const node = toNode(item, opts.facts ?? {});
    const res = validatePageContent({ root: { id: 'root', type: 'section', props: {}, children: node ? [node] : [] } });
    if (node && res.ok) kept.push(res.content.root.children[0]!);
    else dropped.push({ index, type: node?.type ?? 'unknown', issues: res.ok ? [{ path: `[${index}]`, message: 'Not a block' }] : res.issues });
  });
  return { content: { root: { id: 'root', type: 'section', props: { background: 'default', paddingY: 'none', width: 'full', anchor: '' }, children: kept } }, dropped };
}

function toNode(raw: unknown, facts: Readonly<Record<string, string>>): BlockNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { type?: unknown; props?: unknown; children?: unknown };
  if (typeof r.type !== 'string') return null;
  const children = Array.isArray(r.children) ? r.children.map((c) => toNode(c, facts)).filter((c): c is BlockNode => Boolean(c)) : [];
  const props = r.props && typeof r.props === 'object' && !Array.isArray(r.props) ? (r.props as Record<string, unknown>) : {};
  const def = getBlock(r.type);
  return { id: newId(), type: r.type, props: def ? coerceProps(def, props, facts) : props, children };
}

const TOKEN_RE = /\{\{\s*fact:([a-z0-9_.]+)\s*\}\}/g;

/**
 * Forgives the predictable ways models bend the schema — rich text sent as a plain string, numeric
 * enums sent as "2" — and resolves fact tokens. Anything else is left for validation to judge.
 */
function coerceProps(def: BlockDefinition, props: Record<string, unknown>, facts: Readonly<Record<string, string>>): Record<string, unknown> {
  const defaults = def.defaults() as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const plain = (v: string) => v.replace(TOKEN_RE, (_, key: string) => facts[key] ?? '');
  for (const [k, v] of Object.entries(props)) {
    const meta = def.fields[k];
    if (!meta) continue; // unknown props would only fail validation
    if (meta.kind === 'richtext') out[k] = bindRich(typeof v === 'string' ? textToDoc(v) : v, facts);
    else if (typeof defaults[k] === 'number' && typeof v === 'string' && /^\d+$/.test(v)) out[k] = Number(v);
    else if (typeof v === 'string') out[k] = plain(v);
    else if (meta.kind === 'list' && Array.isArray(v))
      out[k] = v.map((item) => (item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([ik, iv]) => [ik, typeof iv === 'string' ? plain(iv) : iv])) : item));
    else out[k] = v;
  }
  return out;
}

function textToDoc(text: string): unknown {
  const paras = text.split(/\n{2,}/).map((t) => t.trim()).filter(Boolean);
  return { type: 'doc', content: paras.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) };
}

/** Splits text leaves on {{fact:key}}: known keys become factRef nodes, unknown tokens are dropped. */
function bindRich(node: unknown, facts: Readonly<Record<string, string>>): unknown {
  if (!node || typeof node !== 'object') return node;
  const n = node as { content?: unknown };
  if (!Array.isArray(n.content)) return node;
  const content = n.content.flatMap((c: unknown): unknown[] => {
    const t = c as { type?: unknown; text?: unknown; marks?: unknown };
    if (t?.type !== 'text' || typeof t.text !== 'string' || !t.text.includes('{{')) return [bindRich(c, facts)];
    const parts: InlineNode[] = [];
    let last = 0;
    for (const m of t.text.matchAll(TOKEN_RE)) {
      const before = t.text.slice(last, m.index);
      if (before) parts.push({ ...(t as object), text: before } as InlineNode);
      const key = m[1]!;
      if (key in facts && FACT_KEY_RE.test(key)) parts.push({ type: 'factRef', attrs: { factKey: key } });
      last = m.index! + m[0].length;
    }
    const rest = t.text.slice(last);
    if (rest) parts.push({ ...(t as object), text: rest } as InlineNode);
    return parts;
  });
  return { ...n, content };
}
