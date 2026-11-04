/** Migration center (Stage 17). */
export const migrationEn = {
  'site.migration': 'Import',
  'mig.title': 'Move a site to Canon',
  'mig.intro': 'Bring your content from WordPress: posts become a Blog with its own pages, pages keep their hierarchy, and every old address redirects to the new one so search rankings and links survive.',
  'mig.wordpress': 'WordPress',
  'mig.wpHow': 'In WordPress: Tools → Export → All content → Download Export File. Then choose the .xml file here.',
  'mig.choose': 'Choose the export file',
  'mig.checking': 'Reading the export…',
  'mig.report': 'What will be imported from “{title}”',
  'mig.posts': 'Posts: {total} ({published} published, {drafts} drafts)',
  'mig.pages': 'Pages: {total} ({published} published, {drafts} drafts)',
  'mig.categories': 'Categories: {list}',
  'mig.authors': 'Authors: {list}',
  'mig.redirects': 'Old addresses redirected (301): {count}',
  'mig.skipped': 'Not imported: {list}',
  'mig.import': 'Import',
  'mig.importing': 'Importing… this can take a minute for large sites',
  'mig.done': 'Imported: {entries} posts, {pages} pages, {redirects} redirects',
  'mig.openBlog': 'Open the posts',
  'mig.openPages': 'Open the pages',
  'mig.errors': 'Some items could not be imported',
  'mig.other': 'Other platforms',
  'mig.otherHint': 'Tilda, Webflow and Wix exports, and CSV for any table, come next; CSV and JSON already import into any collection (Collections → Import).',
  'mig.again': 'Import another file',
} as const;

export type MigrationMessageKey = keyof typeof migrationEn;
