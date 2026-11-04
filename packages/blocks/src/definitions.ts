import { z } from 'zod';
import { emptyDoc, richTextSchema } from './rich-text';

const safeUrl = z
  .string()
  .max(2048)
  .refine((h) => h === '' || /^(https?:|mailto:|tel:|\/|#)/i.test(h), { message: 'Only http(s), mailto, tel, relative and anchor URLs are allowed' });

/**
 * Stock media shown by link (templates, quick starts). Only these hosts, only https: a page can't
 * point the visitor's browser at an arbitrary server. Swapping in an upload from the media library
 * (mediaId) always wins over the link.
 */
export const EXTERNAL_IMAGE_HOSTS = ['images.unsplash.com', 'picsum.photos', 'fastly.picsum.photos', 'images.pexels.com', 'assets.mixkit.co'] as const;
export const EXTERNAL_VIDEO_HOSTS = ['assets.mixkit.co', 'videos.pexels.com'] as const;
/**
 * An entry template may name a field instead of a link ("{{entry.cover}}"); the filled-in value is
 * checked against the same rules when the entry page is built (bindEntry), and dropped if it fails.
 */
export const ENTRY_LINK_TOKEN_RE = /^\{\{\s*entry\.[a-zA-Z][a-zA-Z0-9_]{0,39}\s*\}\}$/;
const hostIn = (hosts: readonly string[]) => (v: string) => {
  if (v === '' || ENTRY_LINK_TOKEN_RE.test(v)) return true;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password && hosts.includes(u.hostname);
  } catch {
    return false;
  }
};
export const externalImageUrl = z.string().max(2048).refine(hostIn(EXTERNAL_IMAGE_HOSTS), { message: `Image links must be https on ${EXTERNAL_IMAGE_HOSTS.join(', ')}` });
export const externalVideoUrl = z
  .string()
  .max(2048)
  .refine(hostIn(EXTERNAL_VIDEO_HOSTS), { message: `Video files must be https on ${EXTERNAL_VIDEO_HOSTS.join(', ')}` })
  .refine((v) => v === '' || ENTRY_LINK_TOKEN_RE.test(v) || /\.(mp4|webm)(\?|$)/i.test(v), { message: 'Video files must be .mp4 or .webm' });

/** Props holding media links, re-checked after entry tokens are filled in. */
export const MEDIA_LINK_PROPS: Readonly<Record<string, 'image' | 'video'>> = { src: 'image', imageUrl: 'image', videoUrl: 'video', fileUrl: 'video' };

const spacing = z.enum(['none', 'sm', 'md', 'lg', 'xl']);
const align = z.enum(['left', 'center', 'right']);

/** What the inspector needs to know about a prop: kind drives the field widget and AI actions. */
export type FieldKind =
  | 'text'
  | 'textarea'
  | 'richtext'
  | 'url'
  | 'select'
  | 'number'
  | 'toggle'
  | 'media'
  | 'color'
  | 'list'
  | 'form'
  | 'component'
  | 'collection';

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
    imageUrl: externalImageUrl.default(''),
    /** A muted, looping background video (stock file by link). */
    videoUrl: externalVideoUrl.default(''),
    overlay: z.enum(['none', 'light', 'dark']).default('dark'),
    align: align.default('center'),
  }),
  defaults: () => ({ eyebrow: '', title: 'A headline that says what you do', subtitle: '', ctaLabel: '', ctaHref: '', mediaId: '', imageUrl: '', videoUrl: '', overlay: 'dark' as const, align: 'center' as const }),
  fields: {
    eyebrow: { kind: 'text', label: 'Eyebrow', ai: true },
    title: { kind: 'text', label: 'Title', ai: true },
    subtitle: { kind: 'textarea', label: 'Subtitle', ai: true },
    ctaLabel: { kind: 'text', label: 'Button label', ai: true },
    ctaHref: { kind: 'url', label: 'Button link' },
    mediaId: { kind: 'media', label: 'Background image' },
    imageUrl: { kind: 'url', label: 'Background image link (stock)' },
    videoUrl: { kind: 'url', label: 'Background video link (.mp4)' },
    overlay: { kind: 'select', label: 'Darken the background', options: ['none', 'light', 'dark'] },
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
    /** A stock photo by link, used while no library image is chosen. */
    src: externalImageUrl.default(''),
    /** Overrides the media library alt for this placement; empty = use the library alt. */
    alt: z.string().max(300).default(''),
    caption: z.string().max(300).default(''),
    rounded: z.boolean().default(true),
  }),
  defaults: () => ({ mediaId: '', src: '', alt: '', caption: '', rounded: true }),
  fields: {
    mediaId: { kind: 'media', label: 'Image' },
    src: { kind: 'url', label: 'Image link (stock)' },
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
  description: 'An embedded YouTube or Vimeo video, or a video file that can play silently on a loop.',
  category: 'media',
  isContainer: false,
  props: z.object({
    url: z.string().regex(VIDEO_URL, 'Use a YouTube or Vimeo link').or(z.literal('')).default(''),
    fileUrl: externalVideoUrl.default(''),
    autoplay: z.boolean().default(false),
    title: short(200),
  }),
  defaults: () => ({ url: '', fileUrl: '', autoplay: false, title: '' }),
  fields: {
    url: { kind: 'url', label: 'YouTube or Vimeo URL' },
    fileUrl: { kind: 'url', label: 'Or a video file link (.mp4)' },
    autoplay: { kind: 'toggle', label: 'Play silently on a loop (file only)' },
    title: { kind: 'text', label: 'Accessible title', ai: true },
  },
});

/** Privacy-friendly embed URL (youtube-nocookie) for a validated video link, or null. */
export function videoEmbedUrl(url: string): string | null {
  const yt = url.match(/(?:v=|youtu\.be\/)([\w-]{6,20})/);
  if (/youtu/.test(url) && yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}`;
  const vm = url.match(/vimeo\.com\/(\d{4,12})/);
  return vm ? `https://player.vimeo.com/video/${vm[1]}?dnt=1` : null;
}

export const formBlock = define({
  type: 'form',
  name: 'Form',
  description:
    'A lead or contact form built in Forms: fields, consent, spam protection and delivery to your team.',
  category: 'marketing',
  isContainer: false,
  props: z.object({
    formId: z.string().max(40).default(''),
    title: short(160),
    intro: short(400),
    submitLabel: z.string().min(1).max(40).default('Send'),
    layout: z.enum(['stacked', 'card']).default('card'),
  }),
  defaults: () => ({
    formId: '',
    title: 'Get in touch',
    intro: '',
    submitLabel: 'Send',
    layout: 'card' as const,
  }),
  fields: {
    formId: { kind: 'form', label: 'Form' },
    title: { kind: 'text', label: 'Title', ai: true },
    intro: { kind: 'textarea', label: 'Intro', ai: true },
    submitLabel: { kind: 'text', label: 'Button label', ai: true },
    layout: { kind: 'select', label: 'Layout', options: ['stacked', 'card'] },
  },
});

export const groupBlock = define({
  type: 'group',
  name: 'Group',
  description: 'A container that lays out its blocks as a stack, a row or a grid; style it freely.',
  category: 'layout',
  isContainer: true,
  props: z.object({
    layout: z.enum(['stack', 'row', 'grid']).default('stack'),
    gap: z.enum(['none', 'sm', 'md', 'lg']).default('md'),
    align: z.enum(['start', 'center', 'end', 'stretch']).default('stretch'),
    columns: z.number().int().min(2).max(6).default(3),
  }),
  defaults: () => ({ layout: 'stack' as const, gap: 'md' as const, align: 'stretch' as const, columns: 3 }),
  fields: {
    layout: { kind: 'select', label: 'Layout', options: ['stack', 'row', 'grid'] },
    gap: { kind: 'select', label: 'Gap', options: ['none', 'sm', 'md', 'lg'] },
    align: { kind: 'select', label: 'Align items', options: ['start', 'center', 'end', 'stretch'] },
    columns: { kind: 'number', label: 'Grid columns' },
  },
});

/**
 * Free-form block: its children are placed by coordinates (left/top/width per breakpoint in the
 * style layer) inside a centred frame, like a design tool. Height is the block's min-height.
 */
export const canvasBlock = define({
  type: 'canvas',
  name: 'Free-form block',
  description: 'Place text, images, buttons and shapes anywhere by dragging; positions are kept per screen size.',
  category: 'layout',
  isContainer: true,
  props: z.object({
    height: z.number().int().min(80).max(4000).default(560),
    frame: z.enum(['grid', 'window']).default('grid'),
    background: z.enum(['default', 'muted', 'primary', 'dark']).default('default'),
    imageUrl: externalImageUrl.default(''),
    videoUrl: externalVideoUrl.default(''),
    overlay: z.enum(['none', 'light', 'dark']).default('none'),
  }),
  defaults: () => ({ height: 560, frame: 'grid' as const, background: 'default' as const, imageUrl: '', videoUrl: '', overlay: 'none' as const }),
  fields: {
    height: { kind: 'number', label: 'Height (desktop, px)' },
    frame: { kind: 'select', label: 'Positions relative to', options: ['grid', 'window'] },
    background: { kind: 'select', label: 'Background', options: ['default', 'muted', 'primary', 'dark'] },
    imageUrl: { kind: 'url', label: 'Background image link (stock)' },
    videoUrl: { kind: 'url', label: 'Background video link (.mp4)' },
    overlay: { kind: 'select', label: 'Darken the background', options: ['none', 'light', 'dark'] },
  },
});

/** A plain rectangle (or circle) for free-form compositions: colour, radius and size come from styles. */
export const shapeBlock = define({
  type: 'shape',
  name: 'Shape',
  description: 'A rectangle or circle; colour, corners, shadow and size are set in Style.',
  category: 'layout',
  isContainer: false,
  props: z.object({ kind: z.enum(['rectangle', 'circle', 'line']).default('rectangle') }),
  defaults: () => ({ kind: 'rectangle' as const }),
  fields: { kind: { kind: 'select', label: 'Shape', options: ['rectangle', 'circle', 'line'] } },
});

/** Pattern of node and component ids (also used by the style compiler). */
export const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * An instance of a site's global component. The component's tree is expanded in its place when
 * the page is delivered; `overrides` patches props of the component's own blocks by their id.
 */
export const componentBlock = define({
  type: 'component',
  name: 'Component',
  description: "An instance of one of the site's reusable components (header, footer, pricing…). Edit the component once, every page updates.",
  category: 'layout',
  isContainer: false,
  props: z.object({
    componentId: z.string().max(64).default(''),
    overrides: z.record(z.string().regex(NODE_ID_RE), z.record(z.string().max(64), z.unknown())).default({}),
  }),
  defaults: () => ({ componentId: '', overrides: {} }),
  fields: { componentId: { kind: 'component', label: 'Component' } },
});

/**
 * Published entries of a collection as cards (blog posts, products, team, events). Delivery
 * resolves the cards from published snapshots only; they link to entry pages when the
 * collection has a route. Empty image/text fields mean "pick sensibly" (first image field,
 * the AI summary or first long text).
 */
export const collectionListBlock = define({
  type: 'collection-list',
  name: 'Collection list',
  description: 'Cards of published entries from a collection (blog posts, products, events), newest first, optionally filtered by tag.',
  category: 'content',
  isContainer: false,
  props: z.object({
    collection: z.string().max(60).regex(/^[a-z0-9-]*$/).default(''),
    title: short(160),
    layout: z.enum(['grid', 'list']).default('grid'),
    columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(3),
    limit: z.number().int().min(1).max(24).default(6),
    sort: z.enum(['newest', 'oldest', 'title']).default('newest'),
    tag: z.string().trim().toLowerCase().max(40).default(''),
    imageField: z.string().max(40).default(''),
    textField: z.string().max(40).default(''),
    showDate: z.boolean().default(true),
    linkLabel: z.string().max(40).default('Read more'),
    emptyText: z.string().max(200).default('Nothing here yet.'),
  }),
  defaults: () => ({ collection: '', title: 'Latest', layout: 'grid' as const, columns: 3 as const, limit: 6, sort: 'newest' as const, tag: '', imageField: '', textField: '', showDate: true, linkLabel: 'Read more', emptyText: 'Nothing here yet.' }),
  fields: {
    collection: { kind: 'collection', label: 'Collection' },
    title: { kind: 'text', label: 'Title', ai: true },
    layout: { kind: 'select', label: 'Layout', options: ['grid', 'list'] },
    columns: { kind: 'select', label: 'Columns', options: ['1', '2', '3', '4'] },
    limit: { kind: 'number', label: 'How many' },
    sort: { kind: 'select', label: 'Order', options: ['newest', 'oldest', 'title'] },
    tag: { kind: 'text', label: 'Only with tag' },
    imageField: { kind: 'text', label: 'Image field (empty: automatic)' },
    textField: { kind: 'text', label: 'Text field (empty: summary)' },
    showDate: { kind: 'toggle', label: 'Show the date' },
    linkLabel: { kind: 'text', label: 'Link label', ai: true },
    emptyText: { kind: 'text', label: 'When empty', ai: true },
  },
});

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
  formBlock,
  groupBlock,
  componentBlock,
  canvasBlock,
  shapeBlock,
  collectionListBlock,
] as const;
export type KnownBlockType = (typeof BLOCKS)[number]['type'];

const byType = new Map<string, BlockDefinition>(BLOCKS.map((b) => [b.type, b as BlockDefinition]));

export function getBlock(type: string): BlockDefinition | undefined {
  return byType.get(type);
}
