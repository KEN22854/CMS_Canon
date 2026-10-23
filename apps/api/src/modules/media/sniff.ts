export type MediaKind = 'image' | 'video' | 'document';

export interface Sniffed {
  mime: string;
  ext: string;
  kind: MediaKind;
}

/**
 * Content type from magic bytes — the client-declared MIME type is never trusted (a "photo.jpg"
 * that is really HTML would otherwise be served from our media domain).
 * SVG is deliberately not accepted yet: it can carry script and needs sanitising (Phase 3).
 */
export function sniff(buf: Buffer): Sniffed | null {
  const b = (i: number) => buf[i];
  const ascii = (start: number, s: string) => buf.subarray(start, start + s.length).toString('latin1') === s;

  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return { mime: 'image/jpeg', ext: 'jpg', kind: 'image' };
  if (ascii(0, '\x89PNG\r\n\x1a\n')) return { mime: 'image/png', ext: 'png', kind: 'image' };
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { mime: 'image/gif', ext: 'gif', kind: 'image' };
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { mime: 'image/webp', ext: 'webp', kind: 'image' };
  if (ascii(4, 'ftyp')) {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', ext: 'avif', kind: 'image' };
    if (['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].includes(brand)) return { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
    if (brand === 'qt  ') return { mime: 'video/quicktime', ext: 'mov', kind: 'video' };
  }
  if (b(0) === 0x1a && b(1) === 0x45 && b(2) === 0xdf && b(3) === 0xa3) return { mime: 'video/webm', ext: 'webm', kind: 'video' };
  if (ascii(0, '%PDF-')) return { mime: 'application/pdf', ext: 'pdf', kind: 'document' };
  return null;
}
