import { emptyDoc, emptyPageContent, type BlockNode, type PageContent } from '@canon/blocks';
import { createId } from '@paralleldrive/cuid2';
import type { SITE_TEMPLATES } from './sites.dto';

const node = (type: string, props: Record<string, unknown>, children: BlockNode[] = []): BlockNode => ({ id: createId().slice(0, 12), type, props, children });

/** First-run content so a new site renders something meaningful instead of an empty page. */
export function starterHome(template: (typeof SITE_TEMPLATES)[number], siteName: string): PageContent {
  const root = emptyPageContent().root;
  switch (template) {
    case 'blank':
      return { root };
    case 'landing':
      return {
        root: {
          ...root,
          children: [
            node('hero', { eyebrow: 'New', title: `Welcome to ${siteName}`, subtitle: 'Tell visitors what you do and why it matters in one sentence.', ctaLabel: 'Get started', ctaHref: '/contact', mediaId: '', align: 'center' }),
            node('section', { background: 'muted', paddingY: 'lg', width: 'default', anchor: 'features' }, [
              node('heading', { text: 'Why teams choose us', level: 2, align: 'center' }),
              node('text', { doc: emptyDoc('Describe the three outcomes your customers get. Keep it concrete.'), align: 'center' }),
              node('button', { label: 'See pricing', href: '/pricing', variant: 'secondary', align: 'center' }),
            ]),
          ],
        },
      };
    case 'blog':
      return {
        root: { ...root, children: [node('heading', { text: siteName, level: 1, align: 'left' }), node('text', { doc: emptyDoc('Notes, updates and stories.'), align: 'left' })] },
      };
    case 'docs':
      return {
        root: { ...root, children: [node('heading', { text: `${siteName} documentation`, level: 1, align: 'left' }), node('text', { doc: emptyDoc('Start with the quickstart, then explore the guides.'), align: 'left' })] },
      };
  }
}
