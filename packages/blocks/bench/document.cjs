// Document engine timings: validate (on every save) and compile styles (every render) at 100–3000 nodes.
const { validatePageContent, compileStyles } = require('../dist/index.js');

function page(n) {
  const sections = [];
  let made = 1;
  let s = 0;
  while (made < n) {
    const kids = [];
    for (let i = 0; i < 9 && made + 1 + kids.length < n; i++) {
      kids.push({ id: `h${s}_${i}`, type: i % 2 ? 'text' : 'heading', props: i % 2 ? { doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body copy' }] }] } } : { text: `Heading ${i}`, level: 2 }, children: [], styles: { base: { fontSize: `${20 + i}px`, marginTop: '8px', color: '#222222' }, tablet: { fontSize: `${16 + i}px` }, mobileL: { marginTop: '4px' } } });
    }
    sections.push({ id: `s${s}`, type: 'section', props: {}, children: kids, styles: { base: { paddingTop: '64px', backgroundColor: 'token:muted' }, mobileS: { paddingTop: '24px' } } });
    made += 1 + kids.length;
    s++;
  }
  return { root: { id: 'root', type: 'section', props: {}, children: sections } };
}

const time = (fn, runs = 20) => {
  fn();
  const t = process.hrtime.bigint();
  for (let i = 0; i < runs; i++) fn();
  return Number(process.hrtime.bigint() - t) / 1e6 / runs;
};

console.log('| Nodes | JSON size | validate (ms) | compileStyles (ms) | CSS size |');
console.log('|---|---|---|---|---|');
for (const n of [100, 500, 1000, 3000]) {
  const doc = page(n);
  const res = validatePageContent(doc);
  if (!res.ok) throw new Error(JSON.stringify(res.issues.slice(0, 3)));
  const css = compileStyles(doc.root);
  console.log(`| ${n} | ${(JSON.stringify(doc).length / 1024).toFixed(0)} KB | ${time(() => validatePageContent(doc)).toFixed(2)} | ${time(() => compileStyles(doc.root)).toFixed(2)} | ${(css.length / 1024).toFixed(0)} KB |`);
}

// Editor case: one node's styles change (immutable update), the rest keep identity.
console.log('\n| Nodes | compileStyles after one edit (ms) |');
console.log('|---|---|');
for (const n of [100, 500, 1000, 3000]) {
  const doc = page(n);
  compileStyles(doc.root);
  let k = 0;
  const ms = time(() => {
    const s0 = doc.root.children[0];
    const h = s0.children[0];
    const h2 = { ...h, styles: { ...h.styles, base: { ...h.styles.base, fontSize: `${30 + (k++ % 20)}px` } } };
    doc.root = { ...doc.root, children: [{ ...s0, children: [h2, ...s0.children.slice(1)] }, ...doc.root.children.slice(1)] };
    compileStyles(doc.root);
  });
  console.log(`| ${n} | ${ms.toFixed(2)} |`);
}
