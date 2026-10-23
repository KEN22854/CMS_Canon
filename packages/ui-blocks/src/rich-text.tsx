import type { InlineNode, Mark, RichBlockNode, RichTextDoc } from '@canon/blocks';
import type { ReactNode } from 'react';

/** Renders the closed TipTap subset as React elements; nothing here ever injects HTML. */
/** Fact values by key; `showMissing` renders unresolved keys as {key} (builder/preview) instead of nothing. */
type Facts = { values: Record<string, string>; showMissing: boolean };

export function RichText({ doc, facts, showMissing = false }: { doc: RichTextDoc | undefined; facts: Record<string, string>; showMissing?: boolean }) {
  if (!doc?.content) return null;
  const f = { values: facts, showMissing };
  return <>{doc.content.map((b, i) => <RichBlock key={i} node={b} facts={f} />)}</>;
}

function RichBlock({ node, facts }: { node: RichBlockNode; facts: Facts }): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p className="my-4 first:mt-0 last:mb-0">{inline(node.content, facts)}</p>;
    case 'heading': {
      const H = `h${node.attrs.level}` as 'h2';
      return <H className="mb-3 mt-8 font-bold first:mt-0">{inline(node.content, facts)}</H>;
    }
    case 'bulletList':
    case 'orderedList': {
      const L = node.type === 'bulletList' ? 'ul' : 'ol';
      return (
        <L className={`my-4 pl-6 ${node.type === 'bulletList' ? 'list-disc' : 'list-decimal'}`}>
          {node.content.map((li, i) => (
            <li key={i}>{li.content.map((c, j) => <RichBlock key={j} node={c} facts={facts} />)}</li>
          ))}
        </L>
      );
    }
    case 'blockquote':
      return <blockquote className="my-6 border-l-4 border-site-primary pl-4 italic">{node.content.map((c, j) => <RichBlock key={j} node={c} facts={facts} />)}</blockquote>;
  }
}

function inline(nodes: InlineNode[] | undefined, facts: Facts): ReactNode {
  return nodes?.map((n, i) => {
    if (n.type === 'hardBreak') return <br key={i} />;
    // Canon BOUND mention: value comes from the fact graph at publish time, never from stored text.
    if (n.type === 'factRef') return <span key={i} data-fact={n.attrs.factKey}>{facts.values[n.attrs.factKey] ?? (facts.showMissing ? `{${n.attrs.factKey}}` : '')}</span>;
    return <Marked key={i} text={n.text} marks={n.marks ?? []} />;
  });
}

function Marked({ text, marks }: { text: string; marks: Mark[] }): ReactNode {
  return marks.reduce<ReactNode>((acc, m) => {
    switch (m.type) {
      case 'bold':
        return <strong>{acc}</strong>;
      case 'italic':
        return <em>{acc}</em>;
      case 'code':
        return <code className="rounded bg-site-muted px-1">{acc}</code>;
      case 'strike':
        return <s>{acc}</s>;
      case 'link':
        return (
          <a href={m.attrs.href} target={m.attrs.target} rel={m.attrs.target === '_blank' ? 'noopener noreferrer' : undefined} className="text-site-primary underline">
            {acc}
          </a>
        );
    }
  }, text);
}
