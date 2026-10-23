/**
 * Splits a document into retrieval chunks. Sections (a block, an entry field) are the unit of
 * meaning, so chunks never straddle two of them; long sections are cut at sentence boundaries with
 * a small overlap so a fact split across the cut is still retrievable from either side. Each chunk
 * carries its section heading, which is what makes "Pricing → Pro costs …" findable by "pricing".
 */
export interface Section {
  heading?: string;
  text: string;
  /** Where the chunk points to (block id, entry field) — used for deep links in citations. */
  anchor?: string;
}

export interface Chunk {
  index: number;
  text: string;
  heading?: string;
  anchor?: string;
}

export interface ChunkOptions {
  /** Soft target; a single sentence longer than this becomes its own (hard-cut) chunk. */
  maxChars?: number;
  overlapChars?: number;
  /** Tiny sections are merged into the next one under the same heading. */
  minChars?: number;
}

const SENTENCE = /[^.!?。！？\n]+(?:[.!?。！？]+|\n+|$)/g;

export function splitSentences(text: string): string[] {
  return (text.match(SENTENCE) ?? []).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export function chunkSections(sections: readonly Section[], opts: ChunkOptions = {}): Chunk[] {
  const max = opts.maxChars ?? 900;
  const overlap = opts.overlapChars ?? 150;
  const min = opts.minChars ?? 80;
  const out: Chunk[] = [];
  const push = (text: string, s: Section) => {
    const t = text.trim();
    if (t) out.push({ index: out.length, text: t, heading: s.heading, anchor: s.anchor });
  };

  // Merge consecutive small sections under the same heading (e.g. stats items, short FAQ answers).
  const merged: Section[] = [];
  for (const s of sections) {
    const text = s.text.replace(/\s+\n/g, '\n').trim();
    if (!text) continue;
    const prev = merged.at(-1);
    if (prev && prev.heading === s.heading && prev.text.length < min && prev.text.length + text.length <= max) prev.text = `${prev.text}\n${text}`;
    else merged.push({ ...s, text });
  }

  for (const s of merged) {
    if (s.text.length <= max) {
      push(s.text, s);
      continue;
    }
    let cur = '';
    for (const sentence of splitSentences(s.text)) {
      if (sentence.length > max) {
        if (cur) push(cur, s);
        for (let i = 0; i < sentence.length; i += max - overlap) push(sentence.slice(i, i + max), s);
        cur = '';
        continue;
      }
      if (cur && cur.length + sentence.length + 1 > max) {
        push(cur, s);
        // Carry the tail of the previous chunk (whole sentences where possible) as overlap.
        const tail = cur.length > overlap ? cur.slice(cur.length - overlap) : cur;
        const cut = tail.search(/(?<=[.!?])\s/);
        cur = `${cut >= 0 ? tail.slice(cut + 1) : tail} ${sentence}`.trim();
      } else cur = cur ? `${cur} ${sentence}` : sentence;
    }
    push(cur, s);
  }
  return out;
}

/** What gets embedded: the heading travels with the text so the vector knows the context. */
export function embeddingInput(c: Chunk, title: string): string {
  return [title, c.heading && c.heading !== title ? c.heading : '', c.text].filter(Boolean).join('\n');
}
