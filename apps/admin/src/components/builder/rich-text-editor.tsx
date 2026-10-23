'use client';

import { FACT_KEY_RE, richTextSchema, type RichTextDoc } from '@canon/blocks';
import { Node, mergeAttributes, type JSONContent } from '@tiptap/core';
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type Editor, type NodeViewProps } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useQuery } from '@tanstack/react-query';
import { Bold, Braces, Heading2, Heading3, Italic, Link2, List, ListOrdered, Quote, Strikethrough } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useTenantId } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Input } from '../ui';

export interface FactOption {
  key: string;
  displayValue: string;
  predicate: string;
}

/** key → current display value, so fact chips show what the reader will see. */
export const FactsContext = createContext<Record<string, string>>({});

function FactChip({ node, selected }: NodeViewProps) {
  const facts = useContext(FactsContext);
  const key = String(node.attrs.factKey ?? '');
  const value = facts[key];
  return (
    <NodeViewWrapper as="span" className={cn('mx-0.5 inline-flex items-center gap-1 rounded border px-1 align-baseline text-[0.9em]', value ? 'border-primary/40 bg-primary/10 text-primary' : 'border-destructive/40 bg-destructive/10 text-destructive', selected && 'ring-2 ring-primary')} title={`Canon fact ${key} — always renders the current value`}>
      <Braces className="h-3 w-3" aria-hidden />
      {value ?? key}
    </NodeViewWrapper>
  );
}

/** Canon BOUND mention: an atom node holding only the fact key; the value comes from the fact graph. */
const FactRef = Node.create({
  name: 'factRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { factKey: { default: null, parseHTML: (el) => el.getAttribute('data-fact'), renderHTML: (a) => ({ 'data-fact': a.factKey }) } };
  },
  parseHTML() {
    return [{ tag: 'span[data-fact]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), `{{fact:${HTMLAttributes['data-fact']}}}`];
  },
  renderText({ node }) {
    return `{{fact:${node.attrs.factKey}}}`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(FactChip, { as: 'span' });
  },
});

const extensions = [
  StarterKit.configure({
    heading: { levels: [2, 3, 4] },
    codeBlock: false,
    horizontalRule: false,
    underline: false,
    link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto', 'tel'], HTMLAttributes: { rel: null, target: null } },
  }),
  FactRef,
];

/**
 * TipTap emits a superset of what pages may store (extra attrs, unknown marks). Map it onto the
 * closed RichTextDoc subset and drop anything else, so the editor can never smuggle markup past
 * the API's schema.
 */
export function fromTiptap(json: JSONContent): RichTextDoc {
  const marks = (ms: JSONContent['marks']) => {
    const out = (ms ?? []).flatMap((m) => {
      if (m.type === 'bold' || m.type === 'italic' || m.type === 'code' || m.type === 'strike') return [{ type: m.type }];
      const href = typeof m.attrs?.href === 'string' ? m.attrs.href : '';
      if (m.type === 'link' && /^(https?:|mailto:|tel:|\/|#)/i.test(href)) return [{ type: 'link', attrs: { href, ...(m.attrs?.target === '_blank' ? { target: '_blank' } : {}) } }];
      return [];
    });
    return out.length ? { marks: out } : {};
  };
  const inline = (nodes: JSONContent[] = []): unknown[] =>
    nodes.flatMap((n) => {
      if (n.type === 'text' && n.text) return [{ type: 'text', text: n.text, ...marks(n.marks) }];
      if (n.type === 'hardBreak') return [{ type: 'hardBreak' }];
      if (n.type === 'factRef' && typeof n.attrs?.factKey === 'string' && FACT_KEY_RE.test(n.attrs.factKey)) return [{ type: 'factRef', attrs: { factKey: n.attrs.factKey } }];
      return [];
    });
  const block = (n: JSONContent): unknown[] => {
    switch (n.type) {
      case 'paragraph':
        return [{ type: 'paragraph', content: inline(n.content) }];
      case 'heading':
        return [{ type: 'heading', attrs: { level: Math.min(4, Math.max(2, Number(n.attrs?.level) || 2)) }, content: inline(n.content) }];
      case 'bulletList':
      case 'orderedList':
        return [{ type: n.type, content: (n.content ?? []).map((li) => ({ type: 'listItem', content: (li.content ?? []).flatMap(block) })) }];
      case 'blockquote':
        return [{ type: 'blockquote', content: (n.content ?? []).flatMap(block) }];
      default:
        return n.content ? n.content.flatMap(block) : [];
    }
  };
  const doc = { type: 'doc', content: (json.content ?? []).flatMap(block) };
  const parsed = richTextSchema.safeParse(doc);
  return parsed.success ? parsed.data : { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
}

export function RichTextEditor({ id, value, onChange, readOnly, siteId, facts }: { id: string; value: RichTextDoc | undefined; onChange: (doc: RichTextDoc) => void; readOnly: boolean; siteId: string; facts: Record<string, string> }) {
  // The last doc this editor emitted: external changes (undo, AI) differ from it and get loaded in.
  const emitted = useRef<string>(JSON.stringify(value ?? null));
  const editor = useEditor({
    extensions,
    content: (value as JSONContent | undefined) ?? '',
    editable: !readOnly,
    immediatelyRender: false,
    editorProps: { attributes: { id, class: 'prose-sm min-h-32 px-3 py-2 outline-none [&_blockquote]:border-l-4 [&_blockquote]:pl-3 [&_h2]:text-lg [&_h2]:font-bold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_a]:text-primary [&_a]:underline' } },
    onUpdate: ({ editor: e }) => {
      const doc = fromTiptap(e.getJSON());
      emitted.current = JSON.stringify(doc);
      onChange(doc);
    },
  });

  useEffect(() => {
    if (!editor) return;
    const next = JSON.stringify(value ?? null);
    if (next !== emitted.current) {
      emitted.current = next;
      editor.commands.setContent((value as JSONContent | undefined) ?? '', { emitUpdate: false });
    }
  }, [editor, value]);

  useEffect(() => editor?.setEditable(!readOnly), [editor, readOnly]);

  return (
    <FactsContext.Provider value={facts}>
      <div className="rounded-md border border-input bg-background shadow-sm focus-within:ring-1 focus-within:ring-ring">
        {editor && !readOnly && <Toolbar editor={editor} siteId={siteId} />}
        <EditorContent editor={editor} />
      </div>
    </FactsContext.Provider>
  );
}

function Toolbar({ editor, siteId }: { editor: Editor; siteId: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const update = () => force((n) => n + 1);
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
    };
  }, [editor]);

  const btn = (label: string, active: boolean, run: () => void, Icon: typeof Bold) => (
    <button key={label} type="button" aria-label={label} title={label} aria-pressed={active} onMouseDown={(e) => e.preventDefault()} onClick={run} className={cn('rounded p-1 hover:bg-muted', active && 'bg-muted text-primary')}>
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
  const c = () => editor.chain().focus();
  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const href = window.prompt('Link URL (https://…, /path, mailto:)', prev ?? '');
    if (href === null) return;
    if (!href) c().extendMarkRange('link').unsetLink().run();
    else if (/^(https?:|mailto:|tel:|\/|#)/i.test(href)) c().extendMarkRange('link').setLink({ href }).run();
  };
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b px-1 py-0.5">
      {btn('Bold', editor.isActive('bold'), () => c().toggleBold().run(), Bold)}
      {btn('Italic', editor.isActive('italic'), () => c().toggleItalic().run(), Italic)}
      {btn('Strikethrough', editor.isActive('strike'), () => c().toggleStrike().run(), Strikethrough)}
      {btn('Link', editor.isActive('link'), setLink, Link2)}
      <span className="mx-1 h-4 w-px bg-border" />
      {btn('Heading', editor.isActive('heading', { level: 2 }), () => c().toggleHeading({ level: 2 }).run(), Heading2)}
      {btn('Subheading', editor.isActive('heading', { level: 3 }), () => c().toggleHeading({ level: 3 }).run(), Heading3)}
      {btn('Bullet list', editor.isActive('bulletList'), () => c().toggleBulletList().run(), List)}
      {btn('Numbered list', editor.isActive('orderedList'), () => c().toggleOrderedList().run(), ListOrdered)}
      {btn('Quote', editor.isActive('blockquote'), () => c().toggleBlockquote().run(), Quote)}
      <span className="mx-1 h-4 w-px bg-border" />
      <FactPicker siteId={siteId} onPick={(key) => c().insertContent({ type: 'factRef', attrs: { factKey: key } }).insertContent(' ').run()} />
    </div>
  );
}

export function useFacts(siteId: string, q = '') {
  const tid = useTenantId();
  return useQuery({
    queryKey: ['facts', tid, siteId, q],
    queryFn: () => api<{ items: FactOption[] }>(`/facts?siteId=${encodeURIComponent(siteId)}${q ? `&q=${encodeURIComponent(q)}` : ''}`).then((r) => r.items),
    enabled: Boolean(tid),
    staleTime: 30_000,
  });
}

function FactPicker({ siteId, onPick }: { siteId: string; onPick: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const facts = useFacts(siteId, q);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as globalThis.Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 rounded px-1.5 py-1 text-xs font-medium text-primary hover:bg-primary/10" title="Insert a Canon fact (always shows its current value)">
        <Braces className="h-3.5 w-3.5" /> Fact
      </button>
      {open && (
        <div className="absolute left-0 z-40 mt-1 w-72 rounded-md border bg-card p-2 shadow-lg">
          <Input autoFocus placeholder="Search facts (price, plan…)" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 text-xs" />
          <ul className="mt-2 max-h-56 overflow-auto">
            {facts.data?.map((f) => (
              <li key={f.key}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => (onPick(f.key), setOpen(false))}
                  className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
                >
                  <span className="truncate font-mono">{f.key}</span>
                  <span className="shrink-0 font-medium">{f.displayValue}</span>
                </button>
              </li>
            ))}
            {facts.data?.length === 0 && <li className="px-2 py-3 text-center text-xs text-muted-foreground">No facts found. Facts are managed in the Canon module.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
