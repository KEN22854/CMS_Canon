import { describe, expect, it } from 'vitest';
import { chunkSections, embeddingInput, splitSentences } from '../../src/modules/knowledge/chunker';

describe('chunker', () => {
  it('keeps sections apart and short sections whole', () => {
    const chunks = chunkSections([
      { heading: 'Pricing', text: 'Pro costs $49 per month.', anchor: 'b1' },
      { heading: 'Security', text: 'We are SOC 2 certified.', anchor: 'b2' },
    ]);
    expect(chunks.map((c) => [c.heading, c.anchor])).toEqual([
      ['Pricing', 'b1'],
      ['Security', 'b2'],
    ]);
  });

  it('merges tiny consecutive sections under one heading', () => {
    const chunks = chunkSections([
      { heading: 'Stats', text: '99.9% uptime' },
      { heading: 'Stats', text: '120+ integrations' },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('99.9% uptime\n120+ integrations');
  });

  it('cuts long sections at sentence boundaries with overlap', () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about feature ${i} in detail.`);
    const chunks = chunkSections([{ heading: 'Docs', text: sentences.join(' ') }], { maxChars: 300, overlapChars: 80 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(300 + 80);
    // Every chunk after the first starts with a whole sentence carried over from the previous one.
    for (let i = 1; i < chunks.length; i++) {
      const first = splitSentences(chunks[i]!.text)[0]!;
      expect(chunks[i - 1]!.text).toContain(first);
    }
    // Nothing is lost.
    for (const s of sentences) expect(chunks.some((c) => c.text.includes(s))).toBe(true);
  });

  it('hard-cuts a single oversized sentence and builds embedding input with context', () => {
    const chunks = chunkSections([{ heading: 'Blob', text: 'x'.repeat(2000) }], { maxChars: 500, overlapChars: 50 });
    expect(chunks.every((c) => c.text.length <= 500)).toBe(true);
    expect(embeddingInput({ index: 0, text: 'Body', heading: 'Pricing' }, 'Plans')).toBe('Plans\nPricing\nBody');
  });
});
