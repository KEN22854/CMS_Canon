import { z } from 'zod';
import { emptyDoc, richTextSchema } from './rich-text';

const safeUrl = z
  .string()
  .max(2048)
  .refine((h) => h === '' || /^(https?:|mailto:|tel:|\/|#)/i.test(h), { message: 'Only http(s), mailto, tel, relative and anchor URLs are allowed' });

const spacing = z.enum(['none', 'sm', 'md', 'lg', 'xl']);
const align = z.enum(['left', 'center', 'right']);

/** What the inspector needs to know about a prop: kind drives the field widget and AI actions. */
export type FieldKind = 'text' | 'textarea' | 'richtext' | 'url' | 'select' | 'number' | 'toggle' | 'media' | 'color' | 'list';

export interface FieldMeta {
  kind: FieldKind;
  label: string;
  options?: readonly string[];
  /** Text fields the AI may rewrite or translate. Never URLs, ids or enums. */
  ai?: boolean;
  /** kind 'list': the fields of each item (one level deep — lists of lists are not a thing on pages). */
  itemFields?: Record<string, FieldMeta>;
  maxItems?: number;
}

export interface BlockDefinition<S extends z.ZodType = z.ZodType> {
  type: string;
  name: string;
  /** One line for the block palette and for the AI catalog (what the block is *for*). */
  description: string;
  category: 'layout' | 'content' | 'media' | 'navigation' | 'marketing';
  isContainer: boolean;
  /** Undefined = any non-root block. */
  allowedChildren?: readonly string[];
  props: S;
  defaults: () => z.infer<S>;
  fields: Record<string, FieldMeta>;
}

function define<S extends z.ZodType>(d: BlockDefinition<S>): BlockDefinition<S> {
  return d;
}

export const sectionBlock = define({
  type: 'section',
  description: 'Full-width band that groups other blocks; sets background and spacing.',
  name: 'Section',
  category: 'layout',
  isContainer: true,
  props: z.object({
    background: z.enum(['default', 'muted', 'primary', 'dark']).default('default'),
    paddingY: spacing.default('lg'),
    width: z.enum(['narrow', 'default', 'wide', 'full']).default('default'),
    anchor: z.string().regex(/^[a-z0-9-]*$/).max(60).default(''),
  }),
  defaults: () => ({ background: 'default' as const, paddingY: 'lg' as const, width: 'default' as const, anchor: '' }),
  fields: {
    background: { kind: 'select', label: 'Background', options: ['default', 'muted', 'primary', 'dark'] },
    paddingY: { kind: 'select', label: 'Vertical padding', options: ['none', 'sm', 'md', 'lg', 'xl'] },
    width: { kind: 'select', label: 'Content width', options: ['narrow', 'default', 'wide', 'full'] },
    anchor: { kind: 'text', label: 'Anchor id' },
  },
});

export const heroBlock = define({
  type: 'hero',
  description: 'Top-of-page headline with subtitle, call-to-action button and optional background image.',
  name: 'Hero',
  category: 'marketing',
  isContainer: false,
  props: z.object({
    eyebrow: z.string().max(80).default(''),
    title: z.string().min(1).max(160),
    subtitle: z.string().max(400).default(''),
    ctaLabel: z.string().max(40).default(''),
    ctaHref: safeUrl.default(''),
    mediaId: z.string().max(40).default(''),
    align: align.default('center'),
  }),
  defaults: () => ({ eyebrow: '', title: 'A headline that says what you do', subtitle: '', ctaLabel: '', ctaHref: '', mediaId: '', align: 'center' as const }),
  fields: {
    eyebrow: { kind: 'text', label: 'Eyebrow', ai: true },
    title: { kind: 'text', label: 'Title', ai: true },
    subtitle: { kind: 'textarea', label: 'Subtitle', ai: true },
    ctaLabel: { kind: 'text', label: 'Button label', ai: true },
    ctaHref: { kind: 'url', label: 'Button link' },
    mediaId: { kind: 'media', label: 'Background image' },
    align: { kind: 'select', label: 'Alignment', options: ['left', 'center', 'right'] },
  },
});

export const headingBlock = define({
  type: 'heading',
  description: 'A standalone heading (h1–h4).',
  name: 'Heading',
  category: 'content',
  isContainer: false,
  props: z.object({ text: z.string().min(1).max(200), level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(2), align: align.default('left') }),
  defaults: () => ({ text: 'Heading', level: 2 as const, align: 'left' as const }),
  fields: {
    text: { kind: 'text', label: 'Text', ai: true },
    level: { kind: 'select', label: 'Level', options: ['1', '2', '3', '4'] },
    align: { kind: 'select', label: 'Alignment', options: ['left', 'center', 'right'] },
  },
});

export const textBlock = define({
  type: 'text',
  description: 'Rich text: paragraphs, lists, links and Canon fact tokens.',
  name: 'Text',
  category: 'content',
  isContainer: false,
  props: z.object({ doc: richTextSchema, align: align.default('left') }),
  defaults: () => ({ doc: emptyDoc('Start writing…'), align: 'left' as const }),
  fields: {
    doc: { kind: 'richtext', label: 'Text', ai: true },
    align: { kind: 'select', label: 'Alignment', options: ['left', 'center', 'right'] },
  },
});

export const imageBlock = define({
  type: 'image',
  description: 'A single responsive image with optional caption.',
  name: 'Image',
  category: 'media',
  isContainer: false,
  props: z.object({
    mediaId: z.string().max(40).default(''),
    /** Overrides the media library alt for this placement; empty = use the library alt. */
    alt: z.string().max(300).default(''),
    caption: z.string().max(300).default(''),
    rounded: z.boolean().default(true),
  }),
  defaults: () => ({ mediaId: '', alt: '', caption: '', rounded: true }),
  fields: {
    mediaId: { kind: 'media', label: 'Image' },
    alt: { kind: 'text', label: 'Alt text (override)', ai: true },
    caption: { kind: 'text', label: 'Caption', ai: true },
    rounded: { kind: 'toggle', label: 'Rounded corners' },
  },
});

export const buttonBlock = define({
  type: 'button',
  description: 'A call-to-action link styled as a button.',
  name: 'Button',
  category: 'navigation',
  isContainer: false,
  props: z.object({ label: z.string().min(1).max(60), href: safeUrl, variant: z.enum(['primary', 'secondary', 'link']).default('primary'), align: align.default('left') }),
  defaults: () => ({ label: 'Learn more', href: '/', variant: 'primary' as const, align: 'left' as const }),
  fields: {
    label: { kind: 'text', label: 'Label', ai: true },
    href: { kind: 'url', label: 'Link' },
    variant: { kind: 'select', label: 'Style', options: ['primary', 'secondary', 'link'] },
    align: { kind: 'select', label: 'Alignment', options: ['left', 'center', 'right'] },
  },
});

// ── Phase 3 blocks ──────────────────────────────────────────────────────────

const short = (max: number) => z.string().max(max).default('');

export const rowBlock = define({
  type: 'row',
  name: 'Columns',
  description: 'Side-by-side columns that stack on small screens. Contains only Column blocks.',
  category: 'layout',
  isContainer: true,
  allowedChildren: ['column'],
  props: z.object({ gap: z.enum(['sm', 'md', 'lg']).default('md'), verticalAlign: z.enum(['top', 'center', 'bottom']).default('top'), stackBelow: z.enum(['sm', 'md', 'lg']).default('md') }),
  defaults: () => ({ gap: 'md' as const, verticalAlign: 'top' as const, stackBelow: 'md' as const }),
  fields: {
    gap: { kind: 'select', label: 'Gap', options: ['sm', 'md', 'lg'] },
    verticalAlign: { kind: 'select', label: 'Vertical alignment', options: ['top', 'center', 'bottom'] },
    stackBelow: { kind: 'select', label: 'Stack below width', options: ['sm', 'md', 'lg'] },
  },
});

export const columnBlock = define({
  type: 'column',
  name: 'Column',
  description: 'One column inside Columns; holds any content blocks.',
  category: 'layout',
  isContainer: true,
  props: z.object({ width: z.enum(['auto', '1/4', '1/3', '1/2', '2/3', '3/4']).default('auto') }),
  defaults: () => ({ width: 'auto' as const }),
  fields: { width: { kind: 'select', label: 'Width', options: ['auto', '1/4', '1/3', '1/2', '2/3', '3/4'] } },
});

export const spacerBlock = define({
  type: 'spacer',
  name: 'Spacer',
  description: 'Vertical whitespace between blocks.',
  category: 'layout',
  isContainer: false,
  props: z.object({ size: z.enum(['xs', 'sm', 'md', 'lg', 'xl']).default('md') }),
  defaults: () => ({ size: 'md' as const }),
  fields: { size: { kind: 'select', label: 'Size', options: ['xs', 'sm', 'md', 'lg', 'xl'] } },
});

export const dividerBlock = define({
  type: 'divider',
  name: 'Divider',
  description: 'A horizontal rule separating content.',
  category: 'layout',
  isContainer: false,
  props: z.object({ style: z.enum(['solid', 'dashed', 'dotted']).default('solid') }),
  defaults: () => ({ style: 'solid' as const }),
  fields: { style: { kind: 'select', label: 'Style', options: ['solid', 'dashed', 'dotted'] } },
});

export const quoteBlock = define({
  type: 'quote',
  name: 'Quote',
  description: 'A pull quote with attribution.',
  category: 'content',
  isContainer: false,
  props: z.object({ text: z.string().min(1).max(600), author: short(100), role: short(100) }),
  defaults: () => ({ text: 'A memorable sentence worth highlighting.', author: '', role: '' }),
  fields: { text: { kind: 'textarea', label: 'Quote', ai: true }, author: { kind: 'text', label: 'Author' }, role: { kind: 'text', label: 'Role', ai: true } },
});

export const faqBlock = define({
  type: 'faq',
  name: 'FAQ',
  description: 'Frequently asked questions as an expandable list.',
  category: 'marketing',
  isContainer: false,
  props: z.object({
    title: short(160),
    items: z.array(z.object({ q: z.string().min(1).max(300), a: z.string().min(1).max(2_000) })).max(30).default([]),
  }),
  defaults: () => ({ title: 'Frequently asked questions', items: [{ q: 'What is it?', a: 'A short, direct answer.' }] }),
  fields: {
    title: { kind: 'text', label: 'Title', ai: true },
    items: { kind: 'list', label: 'Questions', maxItems: 30, itemFields: { q: { kind: 'text', label: 'Question', ai: true }, a: { kind: 'textarea', label: 'Answer', ai: true } } },
  },
});

export const ctaBlock = define({
  type: 'cta',
  name: 'Call to action',
  description: 'A highlighted band with a headline, a sentence and one button.',
  category: 'marketing',
  isContainer: false,
  props: z.object({
    title: z.string().min(1).max(160),
    text: short(400),
    buttonLabel: z.string().min(1).max(40),
    buttonHref: safeUrl,
    tone: z.enum(['primary', 'muted', 'dark']).default('primary'),
  }),
  defaults: () => ({ title: 'Ready to get started?', text: '', buttonLabel: 'Start free', buttonHref: '/signup', tone: 'primary' as const }),
  fields: {
    title: { kind: 'text', label: 'Title', ai: true },
    text: { kind: 'textarea', label: 'Text', ai: true },
    buttonLabel: { kind: 'text', label: 'Button label', ai: true },
    buttonHref: { kind: 'url', label: 'Button link' },
    tone: { kind: 'select', label: 'Tone', options: ['primary', 'muted', 'dark'] },
  },
});

export const statsBlock = define({
  type: 'stats',
  name: 'Stats',
  description: 'A row of big numbers with labels (e.g. "120+ integrations").',
  category: 'marketing',
  isContainer: false,
  props: z.object({ items: z.array(z.object({ value: z.string().min(1).max(20), label: z.string().min(1).max(80) })).min(1).max(6) }),
  defaults: () => ({ items: [{ value: '99.9%', label: 'Uptime' }, { value: '120+', label: 'Integrations' }, { value: '24/7', label: 'Support' }] }),
  fields: { items: { kind: 'list', label: 'Stats', maxItems: 6, itemFields: { value: { kind: 'text', label: 'Value' }, label: { kind: 'text', label: 'Label', ai: true } } } },
});

export const featuresBlock = define({
  type: 'features',
  name: 'Features',
  description: 'A grid of feature cards, each with a short title and description.',
  category: 'marketing',
  isContainer: false,
  props: z.object({
    title: short(160),
    columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
    items: z.array(z.object({ title: z.string().min(1).max(100), text: z.string().max(400).default('') })).min(1).max(12),
  }),
  defaults: () => ({ title: '', columns: 3 as const, items: [{ title: 'Fast', text: 'Explain the benefit.' }, { title: 'Secure', text: 'Explain the benefit.' }, { title: 'Simple', text: 'Explain the benefit.' }] }),
  fields: {
    title: { kind: 'text', label: 'Title', ai: true },
    columns: { kind: 'select', label: 'Columns', options: ['2', '3', '4'] },
    items: { kind: 'list', label: 'Features', maxItems: 12, itemFields: { title: { kind: 'text', label: 'Title', ai: true }, text: { kind: 'textarea', label: 'Text', ai: true } } },
  },
});

export const testimonialBlock = define({
  type: 'testimonial',
  name: 'Testimonial',
  description: 'A customer quote with name, role and optional photo.',
  category: 'marketing',
  isContainer: false,
  props: z.object({ quote: z.string().min(1).max(600), name: z.string().min(1).max(100), role: short(120), mediaId: short(40) }),
  defaults: () => ({ quote: 'It changed how our team ships.', name: 'Customer name', role: 'Role, Company', mediaId: '' }),
  fields: { quote: { kind: 'textarea', label: 'Quote', ai: true }, name: { kind: 'text', label: 'Name' }, role: { kind: 'text', label: 'Role', ai: true }, mediaId: { kind: 'media', label: 'Photo' } },
});

/** Only well-known video hosts: an arbitrary iframe URL would let any page embed anything. */
const VIDEO_URL = /^https:\/\/(www\.)?(youtube\.com\/watch\?v=[\w-]{6,20}|youtu\.be\/[\w-]{6,20}|vimeo\.com\/\d{4,12})(\S*)$/;

export const videoBlock = define({
  type: 'video',
  name: 'Video',
  description: 'An embedded YouTube or Vimeo video.',
  category: 'media',
  isContainer: false,
  props: z.object({ url: z.string().regex(VIDEO_URL, 'Use a YouTube or Vimeo link').or(z.literal('')).default(''), title: short(200) }),
  defaults: () => ({ url: '', title: '' }),
  fields: { url: { kind: 'url', label: 'YouTube or Vimeo URL' }, title: { kind: 'text', label: 'Accessible title', ai: true } },
});

/** Privacy-friendly embed URL (youtube-nocookie) for a validated video link, or null. */
export function videoEmbedUrl(url: string): string | null {
  const yt = url.match(/(?:v=|youtu\.be\/)([\w-]{6,20})/);
  if (/youtu/.test(url) && yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}`;
  const vm = url.match(/vimeo\.com\/(\d{4,12})/);
  return vm ? `https://player.vimeo.com/video/${vm[1]}?dnt=1` : null;
}

export const BLOCKS = [
  sectionBlock,
  rowBlock,
  columnBlock,
  heroBlock,
  headingBlock,
  textBlock,
  imageBlock,
  videoBlock,
  buttonBlock,
  ctaBlock,
  featuresBlock,
  statsBlock,
  faqBlock,
  quoteBlock,
  testimonialBlock,
  spacerBlock,
  dividerBlock,
] as const;
export type KnownBlockType = (typeof BLOCKS)[number]['type'];

const byType = new Map<string, BlockDefinition>(BLOCKS.map((b) => [b.type, b as BlockDefinition]));

export function getBlock(type: string): BlockDefinition | undefined {
  return byType.get(type);
}
