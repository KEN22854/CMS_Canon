import type { CollectionAiSettings, FieldInput } from './definitions';

export interface CollectionPreset {
  id: string;
  name: string;
  slug: string;
  description: string;
  fields: FieldInput[];
  titleField: string;
  ai: Partial<CollectionAiSettings>;
}

/** Starting points in the admin; every field stays editable after creation. */
export const COLLECTION_PRESETS: CollectionPreset[] = [
  {
    id: 'blog',
    name: 'Blog posts',
    slug: 'posts',
    description: 'Articles with excerpt, body, cover image and category.',
    titleField: 'title',
    ai: { autoTag: true, autoSummary: true, qualityScore: true },
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true, max: 160 },
      { name: 'excerpt', label: 'Excerpt', type: 'textarea', max: 400 },
      { name: 'body', label: 'Body', type: 'richtext', required: true },
      { name: 'cover', label: 'Cover image', type: 'media' },
      { name: 'category', label: 'Category', type: 'select', options: ['News', 'Guides', 'Product', 'Company'] },
      { name: 'publishedOn', label: 'Publish date', type: 'date' },
    ],
  },
  {
    id: 'products',
    name: 'Products',
    slug: 'products',
    description: 'Catalogue items with price, SKU and gallery.',
    titleField: 'name',
    ai: { autoTag: true, qualityScore: true },
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, max: 160 },
      { name: 'sku', label: 'SKU', type: 'text', unique: true, ai: false, max: 60 },
      { name: 'price', label: 'Price', type: 'number', min: 0 },
      { name: 'description', label: 'Description', type: 'richtext' },
      { name: 'images', label: 'Images', type: 'media', multiple: true, max: 12 },
      { name: 'inStock', label: 'In stock', type: 'boolean' },
    ],
  },
  {
    id: 'team',
    name: 'Team members',
    slug: 'team',
    description: 'People with role, bio and photo.',
    titleField: 'name',
    ai: { autoSummary: true },
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, max: 120 },
      { name: 'role', label: 'Role', type: 'text', max: 120 },
      { name: 'bio', label: 'Bio', type: 'textarea', max: 2000 },
      { name: 'photo', label: 'Photo', type: 'media' },
      { name: 'email', label: 'Email', type: 'email', ai: false },
    ],
  },
  {
    id: 'faq',
    name: 'FAQ',
    slug: 'faq',
    description: 'Questions and answers.',
    titleField: 'question',
    ai: { autoTag: true },
    fields: [
      { name: 'question', label: 'Question', type: 'text', required: true, max: 300 },
      { name: 'answer', label: 'Answer', type: 'richtext', required: true },
    ],
  },
  { id: 'blank', name: 'Blank', slug: 'items', description: 'Start from a single title field.', titleField: 'title', ai: {}, fields: [{ name: 'title', label: 'Title', type: 'text', required: true }] },
];
