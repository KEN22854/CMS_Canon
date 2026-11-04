import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToRichText, richTextSchema, richTextToPlain } from '../src';

describe('HTML import', () => {
  it('keeps structure: headings, paragraphs, lists, quotes, marks and safe links', () => {
    const { doc, images } = htmlToRichText(`
      <!-- wp:heading --><h2>How to bake</h2><!-- /wp:heading -->
      <p>Use <strong>good</strong> flour and <em>time</em>. See <a href="https://example.com/rye">the recipe</a>.</p>
      <h5>Small heading</h5>
      <ul><li>Flour</li><li>Water <b>and</b> salt</li></ul>
      <ol><li>Mix</li><li>Wait</li></ol>
      <blockquote><p>Bread is life.</p></blockquote>
      <figure><img src="https://old.example/wp-content/uploads/loaf.jpg" alt="A loaf"><figcaption>Our loaf</figcaption></figure>`);
    expect(richTextSchema.safeParse(doc).success).toBe(true);
    expect(doc.content.map((b) => b.type)).toEqual(['heading', 'paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'paragraph']);
    expect(doc.content[2]).toMatchObject({ attrs: { level: 4 } });
    const p = doc.content[1] as { content: { text: string; marks?: { type: string; attrs?: { href: string } }[] }[] };
    expect(p.content.find((n) => n.text === 'good')?.marks).toEqual([{ type: 'bold' }]);
    expect(p.content.find((n) => n.text === 'the recipe')?.marks).toEqual([{ type: 'link', attrs: { href: 'https://example.com/rye' } }]);
    expect(images).toEqual([{ src: 'https://old.example/wp-content/uploads/loaf.jpg', alt: 'A loaf' }]);
    expect(richTextToPlain(doc)).toContain('Bread is life.');
  });

  it('drops what must not come in: scripts, styles, iframes, unsafe links, event handlers', () => {
    const { doc } = htmlToRichText('<p onclick="steal()">Hi <a href="javascript:alert(1)">there</a></p><script>alert(1)</script><style>p{}</style><iframe src="https://evil"></iframe><p>Bye</p>');
    const json = JSON.stringify(doc);
    expect(json).not.toMatch(/alert|steal|evil|javascript/);
    expect(richTextToPlain(doc)).toBe('Hi there\n\nBye');
    expect(richTextSchema.safeParse(doc).success).toBe(true);
  });

  it('reads WordPress classic content (blank lines are paragraphs) and entities', () => {
    const { doc, textLength } = htmlToRichText('First paragraph &amp; more.\nSame paragraph.\n\nSecond &laquo;quoted&raquo; &#8212; done &#x2713;');
    expect(doc.content).toHaveLength(2);
    expect(richTextToPlain(doc)).toBe('First paragraph & more.\nSame paragraph.\n\nSecond «quoted» — done ✓');
    expect(textLength).toBeGreaterThan(20);
    expect(decodeEntities('&nbsp;&unknown;')).toBe(' &unknown;');
    expect(htmlToRichText('').doc.content).toEqual([{ type: 'paragraph', content: [] }]);
  });
});
