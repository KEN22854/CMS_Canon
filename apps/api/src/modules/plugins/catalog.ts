import type { PluginManifest } from './manifest';

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const tier = (id: string, name: string, price: string, pitch: string, cta: string) => ({
  id: `col-${id}`,
  type: 'column',
  props: { width: '1/3' },
  children: [
    { id: `h-${id}`, type: 'heading', props: { text: name, level: 3, align: 'center' }, children: [] },
    { id: `p-${id}`, type: 'heading', props: { text: price, level: 2, align: 'center' }, children: [] },
    { id: `t-${id}`, type: 'text', props: { doc: doc(pitch), align: 'center' }, children: [] },
    { id: `b-${id}`, type: 'button', props: { label: cta, href: '/signup', variant: id === 'pro' ? 'primary' : 'secondary', align: 'center' }, children: [] },
  ],
});

/**
 * First-party marketplace plugins, synced into the plugins table at boot (versioned: a newer
 * manifest here replaces the stored one; installs that need wider permissions must re-consent).
 */
export const FIRST_PARTY_PLUGINS: PluginManifest[] = [
  {
    name: 'slack-notifications',
    version: '1.0.0',
    displayName: 'Slack notifications',
    description: 'Posts to a Slack channel when pages or entries are published and when a Canon fact changes, so the team sees what went live.',
    author: 'Canon',
    category: 'notifications',
    icon: '💬',
    permissions: [],
    events: ['page.published', 'page.unpublished', 'entry.published', 'fact.changed'],
    settings: [
      { key: 'webhookUrl', label: 'Slack incoming webhook URL', kind: 'secret', required: true, placeholder: 'https://hooks.slack.com/services/…', help: 'Slack → Apps → Incoming Webhooks → Add to channel.' },
      { key: 'channel', label: 'Channel override', kind: 'text', required: false, placeholder: '#marketing' },
    ],
    delivery: { kind: 'builtin', handler: 'slack' },
    blocks: [],
  },
  {
    name: 'automation-webhooks',
    version: '1.0.0',
    displayName: 'Zapier / Make / n8n',
    description: 'Sends content events to an automation platform and gives it a read-only API key, so workflows can react to publishes and read the content.',
    author: 'Canon',
    category: 'automation',
    icon: '⚡',
    permissions: ['content:read'],
    events: ['page.published', 'page.unpublished', 'page.updated', 'entry.published', 'entry.updated', 'fact.changed'],
    settings: [{ key: 'endpoint', label: 'Catch hook URL', kind: 'url', required: true, placeholder: 'https://hooks.zapier.com/hooks/catch/…' }],
    delivery: { kind: 'webhook', urlSetting: 'endpoint' },
    blocks: [],
  },
  {
    name: 'marketing-blocks',
    version: '1.0.0',
    displayName: 'Marketing blocks',
    description: 'Ready-made sections — pricing tiers and a launch announcement — built from Canon blocks, fully editable and AI-aware.',
    author: 'Canon',
    category: 'blocks',
    icon: '🧱',
    permissions: [],
    events: [],
    settings: [],
    blocks: [
      {
        key: 'pricing-tiers',
        name: 'Pricing tiers',
        description: 'Three plans side by side with a call to action each.',
        tree: {
          id: 'pricing',
          type: 'section',
          props: { background: 'muted', paddingY: 'lg', width: 'wide', anchor: 'pricing' },
          children: [
            { id: 'pricing-title', type: 'heading', props: { text: 'Simple, transparent pricing', level: 2, align: 'center' }, children: [] },
            {
              id: 'pricing-row',
              type: 'row',
              props: { gap: 'lg', verticalAlign: 'top', stackBelow: 'md' },
              children: [tier('starter', 'Starter', '$0', 'For trying things out.', 'Start free'), tier('pro', 'Pro', '$49/mo', 'For growing teams.', 'Start trial'), tier('ent', 'Enterprise', 'Custom', 'SSO, audit and support.', 'Contact sales')],
            },
          ],
        },
      },
      {
        key: 'launch-announcement',
        name: 'Launch announcement',
        description: 'A bold call to action for a new product or feature.',
        tree: { id: 'launch', type: 'cta', props: { title: 'Introducing something new', text: 'Tell visitors what changed and why it matters.', buttonLabel: 'See what’s new', buttonHref: '/changelog', tone: 'dark' }, children: [] },
      },
    ],
  },
];
