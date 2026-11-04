/** Site releases (Stage 13): snapshots of what is live and whole-site rollback. */
export const releasesEn = {
  'site.releases': 'Releases',
  'rel.intro': 'A release records what is live right now — every page, component and entry. If a publish goes wrong, roll the whole site back to a release in one step. Drafts are not touched.',
  'rel.create': 'Create release',
  'rel.notePrompt': 'What is in this release? (optional)',
  'rel.created': 'Release {number} recorded',
  'rel.empty': 'No releases yet. Create one before a big change.',
  'rel.title': 'Release {number}',
  'rel.auto': 'automatic',
  'rel.counts': '{pages} pages · {components} components · {entries} entries',
  'rel.review': 'Review and roll back',
  'rel.close': 'Close',
  'rel.restored': 'Back to the release version',
  'rel.unpublished': 'Published later — will go offline',
  'rel.missing': 'Deleted since — skipped',
  'rel.components': 'Components changed: {count}',
  'rel.entries': 'Entries changed: {count}',
  'rel.nothing': 'The site is exactly as in this release.',
  'rel.rollback': 'Roll the site back to release {number}',
  'rel.rollbackConfirm': 'Roll the whole site back to release {number}? A release of the current state is recorded first, so this can be undone.',
  'rel.rolledBack': 'Site rolled back: {restored} pages restored, {unpublished} taken offline. Undo with release {backup}.',
  'rel.urlsNote': 'Page addresses are not part of a release: a page keeps its current URL.',
} as const;

export type ReleasesMessageKey = keyof typeof releasesEn;
