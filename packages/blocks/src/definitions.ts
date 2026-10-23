import { z } from 'zod';
import { emptyDoc, richTextSchema } from './rich-text';

const safeUrl = z
  .string()
  .max(2048)
  .refine((h) => h === '' || /^(https?:|mailto:|tel:|\/|#)/i.test(h), { message: 'Only http(s), mailto, tel, relative and anchor URLs are allowed' });

const spacing = z.enum(['none', 'sm', 'md', 'lg', 'xl']);
const align = z.enum(['left', 'center', 'right']);

/** What the inspector needs to know about a prop: kind drives the field widget and AI actions. */
export type FieldKind = 'text' | 'textarea' | 'richtext' | 'url' | 'select' | 'number' | 'toggle' | 'media' | 'color';

export interface FieldMeta {
  kind: FieldKind;
  label: string;
  options?: readonly string[];
  /** Text fields the AI may rewrite or translate. Never URLs, ids or enums. */
  ai?: boolean;
}

export interface BlockDefinition<S extends z.ZodType = z.ZodType> {
  type: string;
  name: string;
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

/** MVP registry (Phase 2). Phase 3 adds the remaining blocks seeded in the DB registry. */
export const BLOCKS = [sectionBlock, heroBlock, headingBlock, textBlock, imageBlock, buttonBlock] as const;
export type KnownBlockType = (typeof BLOCKS)[number]['type'];

const byType = new Map<string, BlockDefinition>(BLOCKS.map((b) => [b.type, b as BlockDefinition]));

export function getBlock(type: string): BlockDefinition | undefined {
  return byType.get(type);
}
