import { getBlock, NODE_ID_RE } from './definitions';
import type { BlockNode, PageContent } from './tree';

/** Component trees by component id (published ones on the site, working copies in the builder). */
export type ComponentTrees = Record<string, BlockNode>;

export type ComponentOverrides = Record<string, Record<string, unknown>>;

/** Ids of every component the page uses, for loading their trees. */
export function collectComponentIds(root: BlockNode): string[] {
  const out = new Set<string>();
  const walk = (n: BlockNode) => {
    const id = n.props.componentId;
    if (n.type === 'component' && typeof id === 'string' && NODE_ID_RE.test(id)) out.add(id);
    n.children.forEach(walk);
  };
  walk(root);
  return [...out];
}

/** Component blocks may not be the root of a component or sit inside one (no recursion). */
export function componentTreeIssues(tree: BlockNode): string[] {
  const issues: string[] = [];
  if (tree.type === 'column' || tree.type === 'component') issues.push(`A component can't start with a ${tree.type} block`);
  const walk = (n: BlockNode) => {
    if (n !== tree && n.type === 'component') issues.push('Components cannot contain other components');
    n.children.forEach(walk);
  };
  walk(tree);
  return issues;
}

/**
 * One instance turned into real blocks. The component's root takes the instance's id (so the
 * instance's own styles, name and visibility apply to it); inner ids get the instance id as a
 * prefix, which keeps them unique when a component is used several times on a page. `overrides`
 * patches props of inner blocks by their id in the component; a patch that would make the
 * props invalid is ignored rather than breaking the page.
 */
export function expandInstance(instance: BlockNode, tree: BlockNode): BlockNode {
  const overrides = (instance.props.overrides ?? {}) as ComponentOverrides;
  const copy = (n: BlockNode, isRoot: boolean): BlockNode | null => {
    if (n.type === 'component') return null;
    const patch = overrides[n.id];
    let props = n.props;
    if (patch && typeof patch === 'object') {
      const merged = { ...n.props, ...patch };
      if (getBlock(n.type)?.props.safeParse(merged).success) props = merged;
    }
    const id = isRoot ? instance.id : `${instance.id}-${n.id}`.slice(0, 64);
    const out: BlockNode = { ...n, id, props, children: n.children.map((c) => copy(c, false)).filter((c): c is BlockNode => c !== null) };
    return out;
  };
  const root = copy(tree, true)!;
  const { styles, hidden, name } = instance;
  if (styles) root.styles = styles;
  if (hidden) root.hidden = true;
  else delete root.hidden;
  if (name) root.name = name;
  delete root.locked;
  return root;
}

/**
 * Replaces every component block with its tree. Instances of unknown or deleted components are
 * dropped, so a missing component renders nothing instead of an error.
 */
export function expandComponents(content: PageContent, trees: ComponentTrees): PageContent {
  let changed = false;
  const walk = (n: BlockNode): BlockNode | null => {
    if (n.type === 'component') {
      changed = true;
      const tree = trees[String(n.props.componentId ?? '')];
      return tree ? expandInstance(n, tree) : null;
    }
    let childChanged = false;
    const children = n.children.map((c) => {
      const m = walk(c);
      if (m !== c) childChanged = true;
      return m;
    });
    return childChanged ? { ...n, children: children.filter((c): c is BlockNode => c !== null) } : n;
  };
  const root = walk(content.root);
  return changed && root ? { root } : content;
}

/** Props of inner blocks that instances may override: the text fields the AI may rewrite too. */
export function overridableFields(tree: BlockNode): { nodeId: string; type: string; field: string; label: string; kind: string; value: unknown }[] {
  const out: { nodeId: string; type: string; field: string; label: string; kind: string; value: unknown }[] = [];
  const walk = (n: BlockNode) => {
    const def = getBlock(n.type);
    for (const [field, meta] of Object.entries(def?.fields ?? {})) {
      if ((meta.kind === 'text' || meta.kind === 'textarea' || meta.kind === 'url') && (meta.ai || meta.kind === 'url')) out.push({ nodeId: n.id, type: n.type, field, label: meta.label, kind: meta.kind, value: n.props[field] });
    }
    n.children.forEach(walk);
  };
  walk(tree);
  return out;
}
