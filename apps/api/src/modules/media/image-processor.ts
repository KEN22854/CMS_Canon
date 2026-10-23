import sharp from 'sharp';

/** Responsive breakpoints; widths above the original are skipped (no upscaling). */
export const VARIANT_WIDTHS = [320, 640, 1024, 1600, 2400] as const;
const THUMB = 384;
/** Decompression-bomb guard: refuse images whose pixel count exceeds this. */
const MAX_PIXELS = 100_000_000;

export interface ProcessedVariant {
  name: string;
  width: number;
  height: number;
  format: 'webp' | 'avif';
  contentType: string;
  buffer: Buffer;
}

export interface ProcessedImage {
  width: number;
  height: number;
  /** Original re-encoded without metadata (EXIF GPS etc. would otherwise leak to the public site). */
  sanitized: { buffer: Buffer; contentType: string };
  variants: ProcessedVariant[];
  thumb: ProcessedVariant;
  dominantColor: string;
  hasAlpha: boolean;
  animated: boolean;
}

export async function processImage(input: Buffer, mime: string): Promise<ProcessedImage> {
  const base = sharp(input, { limitInputPixels: MAX_PIXELS, animated: mime === 'image/gif' || mime === 'image/webp' });
  const meta = await base.metadata();
  const animated = (meta.pages ?? 1) > 1;
  // rotate() applies the EXIF orientation, so phones' portrait photos don't render sideways.
  const oriented = sharp(input, { limitInputPixels: MAX_PIXELS, animated }).rotate();
  const { data: sanitizedBuf, info } = await oriented.clone().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.pageHeight ?? info.height;

  const stats = await sharp(sanitizedBuf, { animated: false }).stats();
  const d = stats.dominant;
  const dominantColor = `#${[d.r, d.g, d.b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;

  const widths = VARIANT_WIDTHS.filter((w) => w < width);
  if (widths.length === 0 || widths.at(-1)! < width) widths.push(Math.min(width, VARIANT_WIDTHS.at(-1)!) as (typeof VARIANT_WIDTHS)[number]);

  const variants: ProcessedVariant[] = [];
  for (const w of [...new Set(widths)]) {
    const resized = oriented.clone().resize({ width: w, withoutEnlargement: true });
    const webp = await resized.clone().webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    variants.push({ name: `w${w}.webp`, width: webp.info.width, height: webp.info.pageHeight ?? webp.info.height, format: 'webp', contentType: 'image/webp', buffer: webp.data });
    // AVIF is ~30% smaller than WebP but slow to encode; animated AVIF support is spotty, so skip it there.
    if (!animated) {
      const avif = await resized.clone().avif({ quality: 55, effort: 3 }).toBuffer({ resolveWithObject: true });
      variants.push({ name: `w${w}.avif`, width: avif.info.width, height: avif.info.height, format: 'avif', contentType: 'image/avif', buffer: avif.data });
    }
  }
  const thumbOut = await oriented.clone().resize({ width: THUMB, height: THUMB, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer({ resolveWithObject: true });

  return {
    width,
    height,
    sanitized: { buffer: sanitizedBuf, contentType: mime },
    variants,
    thumb: { name: 'thumb.webp', width: thumbOut.info.width, height: thumbOut.info.pageHeight ?? thumbOut.info.height, format: 'webp', contentType: 'image/webp', buffer: thumbOut.data },
    dominantColor,
    hasAlpha: Boolean(meta.hasAlpha),
    animated,
  };
}
