/**
 * Core block registry rows. Phase 3 replaces the hand-written JSON Schemas with ones generated from
 * the Zod definitions in packages/blocks (single source of truth); the row shape stays the same.
 */
export interface SeedBlock {
  type: string;
  name: string;
  category: 'layout' | 'content' | 'media' | 'navigation' | 'forms' | 'marketing' | 'commerce' | 'advanced' | 'ai';
  icon: string;
  isContainer?: boolean;
  allowedChildren?: string[];
  props?: Record<string, { type: string; default?: unknown; enum?: string[] }>;
}

const richText = { type: 'object' } as const;

export const CORE_BLOCKS: SeedBlock[] = [
  // layout
  { type: 'section', name: 'Section', category: 'layout', icon: 'square', isContainer: true },
  { type: 'container', name: 'Container', category: 'layout', icon: 'box', isContainer: true },
  { type: 'row', name: 'Row', category: 'layout', icon: 'rows-3', isContainer: true, allowedChildren: ['column'] },
  { type: 'column', name: 'Column', category: 'layout', icon: 'columns-3', isContainer: true },
  { type: 'grid', name: 'Grid', category: 'layout', icon: 'layout-grid', isContainer: true, props: { columns: { type: 'number', default: 3 } } },
  { type: 'tabs', name: 'Tabs', category: 'layout', icon: 'panel-top', isContainer: true },
  { type: 'accordion', name: 'Accordion', category: 'layout', icon: 'list-collapse', isContainer: true },
  { type: 'spacer', name: 'Spacer', category: 'layout', icon: 'move-vertical', props: { size: { type: 'string', default: 'md', enum: ['xs', 'sm', 'md', 'lg', 'xl'] } } },
  { type: 'divider', name: 'Divider', category: 'layout', icon: 'minus' },
  // content
  { type: 'heading', name: 'Heading', category: 'content', icon: 'heading', props: { text: { type: 'string', default: 'Heading' }, level: { type: 'number', default: 2 } } },
  { type: 'text', name: 'Text', category: 'content', icon: 'type', props: { doc: richText } },
  { type: 'list', name: 'List', category: 'content', icon: 'list' },
  { type: 'quote', name: 'Quote', category: 'content', icon: 'quote', props: { text: { type: 'string' }, author: { type: 'string' } } },
  { type: 'code', name: 'Code', category: 'content', icon: 'code', props: { code: { type: 'string' }, language: { type: 'string', default: 'ts' } } },
  { type: 'table', name: 'Table', category: 'content', icon: 'table' },
  { type: 'badge', name: 'Badge', category: 'content', icon: 'badge' },
  { type: 'alert', name: 'Alert', category: 'content', icon: 'triangle-alert' },
  { type: 'card', name: 'Card', category: 'content', icon: 'square-stack', isContainer: true },
  { type: 'icon', name: 'Icon', category: 'content', icon: 'smile' },
  { type: 'markdown', name: 'Markdown', category: 'content', icon: 'file-text', props: { source: { type: 'string' } } },
  // media
  { type: 'image', name: 'Image', category: 'media', icon: 'image', props: { mediaId: { type: 'string' }, alt: { type: 'string' } } },
  { type: 'gallery', name: 'Gallery', category: 'media', icon: 'images' },
  { type: 'video', name: 'Video', category: 'media', icon: 'video' },
  { type: 'embed', name: 'Embed', category: 'media', icon: 'square-code' },
  { type: 'iframe', name: 'Iframe', category: 'media', icon: 'app-window' },
  // navigation
  { type: 'navbar', name: 'Navbar', category: 'navigation', icon: 'panel-top' },
  { type: 'footer', name: 'Footer', category: 'navigation', icon: 'panel-bottom' },
  { type: 'menu', name: 'Menu', category: 'navigation', icon: 'menu' },
  { type: 'breadcrumbs', name: 'Breadcrumbs', category: 'navigation', icon: 'chevrons-right' },
  { type: 'pagination', name: 'Pagination', category: 'navigation', icon: 'ellipsis' },
  { type: 'button', name: 'Button', category: 'navigation', icon: 'mouse-pointer-click', props: { label: { type: 'string', default: 'Click' }, href: { type: 'string' } } },
  { type: 'link', name: 'Link', category: 'navigation', icon: 'link' },
  { type: 'social', name: 'Social links', category: 'navigation', icon: 'share-2' },
  { type: 'logo', name: 'Logo', category: 'navigation', icon: 'hexagon' },
  // forms
  { type: 'form', name: 'Form', category: 'forms', icon: 'clipboard-list', props: { formId: { type: 'string' } } },
  { type: 'newsletter', name: 'Newsletter', category: 'forms', icon: 'mail' },
  // marketing
  { type: 'hero', name: 'Hero', category: 'marketing', icon: 'sparkles', props: { title: { type: 'string', default: 'Headline' }, subtitle: { type: 'string' }, ctaLabel: { type: 'string' }, ctaHref: { type: 'string' } } },
  { type: 'cta', name: 'Call to action', category: 'marketing', icon: 'megaphone' },
  { type: 'pricing', name: 'Pricing', category: 'marketing', icon: 'badge-dollar-sign', props: { plans: { type: 'array' } } },
  { type: 'testimonials', name: 'Testimonials', category: 'marketing', icon: 'message-square-quote' },
  { type: 'faq', name: 'FAQ', category: 'marketing', icon: 'circle-help', props: { items: { type: 'array' } } },
  { type: 'stats', name: 'Stats', category: 'marketing', icon: 'chart-column' },
  { type: 'countdown', name: 'Countdown', category: 'marketing', icon: 'timer' },
  // commerce
  { type: 'product-card', name: 'Product card', category: 'commerce', icon: 'shopping-bag' },
  { type: 'product-grid', name: 'Product grid', category: 'commerce', icon: 'store' },
  // advanced
  { type: 'raw-html', name: 'Raw HTML', category: 'advanced', icon: 'file-code' },
  { type: 'custom-react', name: 'Custom React', category: 'advanced', icon: 'atom' },
  // ai
  { type: 'ai-chat', name: 'AI chat widget', category: 'ai', icon: 'bot', props: { groundedOnly: { type: 'boolean', default: true } } },
  { type: 'ai-content', name: 'AI-generated content', category: 'ai', icon: 'wand-sparkles', props: { promptName: { type: 'string' } } },
  { type: 'fact', name: 'Canon fact', category: 'ai', icon: 'fingerprint', props: { factKey: { type: 'string' } } },
];

export function toJsonSchema(block: SeedBlock): { schema: object; defaults: Record<string, unknown> } {
  const properties: Record<string, object> = {};
  const defaults: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(block.props ?? {})) {
    properties[key] = def.enum ? { type: def.type, enum: def.enum } : { type: def.type };
    if (def.default !== undefined) defaults[key] = def.default;
  }
  return { schema: { type: 'object', properties, additionalProperties: true }, defaults };
}
