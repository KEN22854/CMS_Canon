/** Funnels (Stage 12). */
export const funnelEn = {
  'funnel.title': 'Funnels',
  'funnel.intro': 'How many visitors go through your steps in order — and where they drop off.',
  'funnel.new': 'New funnel',
  'funnel.empty': 'No funnels yet. Example: Product page → add_to_cart → /cart → purchase.',
  'funnel.name': 'Name',
  'funnel.window': 'Steps must happen',
  'funnel.window.session': 'In one visit',
  'funnel.window.days': 'Within {days} days',
  'funnel.step': 'Step {n}',
  'funnel.kind.page': 'Visits a page',
  'funnel.kind.event': 'Does an event',
  'funnel.path': 'Path (/pricing, or /blog/* for a section)',
  'funnel.event': 'Event (cta_click, form_submit, purchase…)',
  'funnel.addStep': 'Add step',
  'funnel.removeStep': 'Remove step {n}',
  'funnel.save': 'Save funnel',
  'funnel.cancel': 'Cancel',
  'funnel.saved': 'Funnel saved',
  'funnel.delete': 'Delete funnel “{name}”',
  'funnel.visitors': '{count} visitors',
  'funnel.ofFirst': '{pct} of the first step',
  'funnel.drop': '−{pct} here',
  'funnel.conversion': 'Converts {pct}',
} as const;

export type FunnelMessageKey = keyof typeof funnelEn;
