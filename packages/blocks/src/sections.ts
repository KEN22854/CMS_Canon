import { newId } from './edit';
import type { RichTextDoc } from './rich-text';
import type { StyleProps } from './styles';
import type { BlockNode } from './tree';

/**
 * Ready-made sections (Stage 4): whole page sections assembled from the regular blocks, so after
 * inserting everything is editable, styleable and translatable like hand-built content. Each
 * layout comes in four tones; copy exists in English and Russian (picked by the page locale).
 */

export const SECTION_CATEGORIES = ['hero', 'freeform', 'features', 'proof', 'pricing', 'cta', 'faq', 'team', 'contact', 'content', 'shop', 'navigation'] as const;
export type SectionCategory = (typeof SECTION_CATEGORIES)[number];

export const SECTION_TONES = ['light', 'muted', 'dark', 'brand'] as const;
export type SectionTone = (typeof SECTION_TONES)[number];

export interface SectionPreset {
  key: string;
  category: SectionCategory;
  /** English name and description; the admin shows translated ones by key. */
  name: string;
  description: string;
  /** Russian name for the library (the admin dictionary may override it). */
  nameRu?: string;
  build: (locale: string, tone: SectionTone) => BlockNode;
}

type Copy = readonly [en: string, ru: string];
const pick = (locale: string, c: Copy) => (locale.toLowerCase().startsWith('ru') ? c[1] : c[0]);

const TONE_STYLES: Record<SectionTone, StyleProps> = {
  light: { backgroundColor: 'token:background', color: 'token:foreground' },
  muted: { backgroundColor: 'token:muted', color: 'token:foreground' },
  dark: { backgroundColor: 'token:foreground', color: 'token:background' },
  brand: { backgroundColor: 'token:primary', color: '#ffffff' },
};

/** The gradient hero's four tones. */
const GRADIENTS: Record<SectionTone, string> = {
  light: 'linear-gradient(135deg, #F4F2FF, #E6F7FB)',
  muted: 'linear-gradient(135deg, #D9D3FF, #C3EEF7)',
  dark: 'linear-gradient(135deg, #0B0D12, #2A2350)',
  brand: 'linear-gradient(135deg, #8B7CFF, #42C8E8)',
};

const node = (type: string, props: Record<string, unknown> = {}, children: BlockNode[] = [], styles?: StyleProps, name?: string): BlockNode => ({
  id: newId(),
  type,
  props,
  children,
  ...(styles ? { styles: { base: styles } } : {}),
  ...(name ? { name } : {}),
});

const doc = (...paragraphs: string[]): RichTextDoc => ({ type: 'doc', content: paragraphs.map((t) => ({ type: 'paragraph' as const, content: [{ type: 'text' as const, text: t }] })) });

/** Section band with the tone applied as styles (they override the section's own background). */
const band = (tone: SectionTone, children: BlockNode[], name: string, width: 'narrow' | 'default' | 'wide' = 'default', paddingY: 'md' | 'lg' | 'xl' = 'lg') => node('section', { background: 'default', paddingY, width, anchor: '' }, children, TONE_STYLES[tone], name);

const heading = (text: string, level: number, align: 'left' | 'center' = 'left', styles?: StyleProps) => node('heading', { text, level, align }, [], styles);
const text = (align: 'left' | 'center', ...p: string[]) => node('text', { doc: doc(...p), align });
const button = (label: string, href: string, variant: 'primary' | 'secondary' | 'link' = 'primary', align: 'left' | 'center' | 'right' = 'left') => node('button', { label, href, variant, align });
const image = (alt: string, styles?: StyleProps) => node('image', { mediaId: '', alt, caption: '', rounded: true }, [], styles);
const group = (layout: 'stack' | 'row' | 'grid', children: BlockNode[], opts: { gap?: 'none' | 'sm' | 'md' | 'lg'; align?: 'start' | 'center' | 'end' | 'stretch'; columns?: number } = {}, styles?: StyleProps, name?: string) =>
  node('group', { layout, gap: opts.gap ?? 'md', align: opts.align ?? 'stretch', columns: opts.columns ?? 3 }, children, styles, name);
const columns = (...cols: BlockNode[][]) => node('row', { gap: 'lg', verticalAlign: 'center', stackBelow: 'md' }, cols.map((c) => node('column', { width: 'auto' }, c)));
const card = (children: BlockNode[], styles: StyleProps = {}) => group('stack', children, { gap: 'sm' }, { paddingTop: '24px', paddingBottom: '24px', paddingLeft: '24px', paddingRight: '24px', borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgb(127 127 127 / 0.25)', borderRadius: '16px', ...styles });

const T = {
  heroTitle: ['Launch your next idea faster', 'Запустите новую идею быстрее'],
  heroSub: ['One platform for your website, content and growth — built for teams that move quickly.', 'Одна платформа для сайта, контента и роста — для команд, которые двигаются быстро.'],
  start: ['Start free', 'Начать бесплатно'],
  demo: ['Book a demo', 'Записаться на демо'],
  learn: ['Learn more', 'Подробнее'],
  eyebrow: ['New', 'Новинка'],
  featuresTitle: ['Everything you need to grow', 'Всё, что нужно для роста'],
  f1: ['Fast', 'Быстро'],
  f1t: ['Pages load in under a second on any device.', 'Страницы открываются меньше чем за секунду на любом устройстве.'],
  f2: ['Secure', 'Надёжно'],
  f2t: ['Encryption, backups and access control by default.', 'Шифрование, резервные копии и контроль доступа по умолчанию.'],
  f3: ['Simple', 'Просто'],
  f3t: ['Edit visually; publish in one click.', 'Редактируйте визуально, публикуйте в один клик.'],
  f4: ['Connected', 'Интеграции'],
  f4t: ['Works with the tools your team already uses.', 'Работает с инструментами, которыми команда уже пользуется.'],
  statsTitle: ['Trusted by growing teams', 'Нам доверяют растущие команды'],
  s1: ['Customers', 'Клиентов'],
  s2: ['Uptime', 'Доступность'],
  s3: ['Countries', 'Стран'],
  logos: ['Trusted by teams at', 'Нам доверяют команды'],
  quote: ['We rebuilt our site in a week and doubled sign-ups.', 'Мы пересобрали сайт за неделю и удвоили число регистраций.'],
  quoteName: ['Anna Petrova', 'Анна Петрова'],
  quoteRole: ['Head of Marketing, Northwind', 'Директор по маркетингу, Northwind'],
  pricingTitle: ['Simple, transparent pricing', 'Простые и прозрачные цены'],
  pricingSub: ['Start free. Upgrade when you grow.', 'Начните бесплатно. Переходите на тариф, когда вырастете.'],
  planStarter: ['Starter', 'Старт'],
  planPro: ['Pro', 'Профи'],
  planTeam: ['Team', 'Команда'],
  perMonth: ['per month', 'в месяц'],
  planStarterT: ['1 site · 1 editor · Community support', '1 сайт · 1 редактор · Поддержка сообщества'],
  planProT: ['5 sites · 5 editors · AI tools · Email support', '5 сайтов · 5 редакторов · AI-инструменты · Поддержка по почте'],
  planTeamT: ['Unlimited sites · SSO · Priority support', 'Без ограничений · SSO · Приоритетная поддержка'],
  choose: ['Choose plan', 'Выбрать тариф'],
  ctaTitle: ['Ready to get started?', 'Готовы начать?'],
  ctaText: ['Create your site in minutes. No credit card required.', 'Создайте сайт за несколько минут. Карта не нужна.'],
  newsletter: ['Get product news', 'Новости продукта'],
  newsletterT: ['One email a month. Unsubscribe anytime.', 'Одно письмо в месяц. Отписаться можно в любой момент.'],
  faqTitle: ['Frequently asked questions', 'Частые вопросы'],
  q1: ['Can I try it for free?', 'Можно попробовать бесплатно?'],
  a1: ['Yes — the Starter plan is free forever.', 'Да — тариф «Старт» бесплатный навсегда.'],
  q2: ['Can I use my own domain?', 'Можно подключить свой домен?'],
  a2: ['Yes. Add it in the site settings and follow the DNS steps.', 'Да. Добавьте его в настройках сайта и выполните шаги по DNS.'],
  q3: ['How do I cancel?', 'Как отменить подписку?'],
  a3: ['Anytime from the billing page; your data stays exportable.', 'В любой момент на странице оплаты; данные можно выгрузить.'],
  faqSide: ['Still have questions? Our team answers within a day.', 'Остались вопросы? Команда ответит в течение дня.'],
  contactUs: ['Contact us', 'Связаться с нами'],
  teamTitle: ['Meet the team', 'Наша команда'],
  member: ['Team member', 'Участник команды'],
  role: ['Role', 'Должность'],
  storyTitle: ['Our story', 'Наша история'],
  story1: ['We started in 2019 with a simple idea: websites should be easy to build and fast for everyone.', 'Мы начали в 2019 году с простой идеи: сайты должно быть легко делать, и они должны быть быстрыми для всех.'],
  story2: ['Today we help thousands of teams publish with confidence.', 'Сегодня мы помогаем тысячам команд уверенно публиковать.'],
  contactTitle: ['Get in touch', 'Напишите нам'],
  contactText: ['hello@example.com · +1 555 0100', 'hello@example.com · +7 900 000-00-00'],
  contactHours: ['Mon–Fri, 9:00–18:00', 'Пн–Пт, 9:00–18:00'],
  videoTitle: ['See it in action', 'Посмотрите, как это работает'],
  videoText: ['A two-minute tour of the product.', 'Двухминутный обзор продукта.'],
  galleryTitle: ['Gallery', 'Галерея'],
  articleTitle: ['A headline for your article', 'Заголовок вашей статьи'],
  articleLead: ['A short introduction that tells readers what they will learn.', 'Короткое вступление: о чём статья и что узнает читатель.'],
  articleBody: ['Write the main text here. Keep paragraphs short and focused on one idea each.', 'Основной текст здесь. Делайте абзацы короткими, по одной мысли в каждом.'],
  brand: ['Your brand', 'Ваш бренд'],
  product: ['Product', 'Продукт'],
  company: ['Company', 'Компания'],
  resources: ['Resources', 'Ресурсы'],
  legal: ['Legal', 'Документы'],
  links1: ['Features · Pricing · Changelog', 'Возможности · Цены · Обновления'],
  links2: ['About · Careers · Press', 'О нас · Вакансии · Пресса'],
  links3: ['Docs · Blog · Support', 'Документация · Блог · Поддержка'],
  links4: ['Privacy · Terms · Cookies', 'Конфиденциальность · Условия · Cookies'],
  copyright: ['© 2026 Your company. All rights reserved.', '© 2026 Ваша компания. Все права защищены.'],
  login: ['Log in', 'Войти'],
  subscribe: ['Subscribe', 'Подписаться'],
  send: ['Send', 'Отправить'],
  stepsTitle: ['How it works', 'Как это работает'],
  step1: ['Pick a template', 'Выберите шаблон'],
  step2: ['Make it yours', 'Настройте под себя'],
  step3: ['Publish', 'Опубликуйте'],
  stepT: ['A sentence about this step.', 'Одна фраза об этом шаге.'],
} satisfies Record<string, Copy>;

const preset = (key: string, category: SectionCategory, name: string, description: string, build: (c: (k: keyof typeof T) => string, tone: SectionTone, locale: string) => BlockNode): SectionPreset => ({
  key,
  category,
  name,
  description,
  build: (locale, tone) => build((k) => pick(locale, T[k]), tone, locale),
});

const tf = (c: (k: keyof typeof T) => string, n: 2 | 3 | 4) =>
  [
    { title: c('f1'), text: c('f1t') },
    { title: c('f2'), text: c('f2t') },
    { title: c('f3'), text: c('f3t') },
    { title: c('f4'), text: c('f4t') },
  ].slice(0, n);

const plan = (c: (k: keyof typeof T) => string, name: keyof typeof T, price: string, features: keyof typeof T, highlight = false) =>
  card([heading(c(name), 3), heading(price, 2, 'left', { fontSize: '40px' }), text('left', c('perMonth')), text('left', c(features)), button(c('choose'), '/signup', highlight ? 'primary' : 'secondary')], highlight ? { borderColor: 'token:primary', borderWidth: '2px' } : {});

export const SECTION_PRESETS: SectionPreset[] = [
  // hero
  preset('hero-centered', 'hero', 'Hero · centered', 'Big centred headline, subtitle and one button.', (c, tone) => node('hero', { eyebrow: c('eyebrow'), title: c('heroTitle'), subtitle: c('heroSub'), ctaLabel: c('start'), ctaHref: '/signup', mediaId: '', align: 'center' }, [], TONE_STYLES[tone], 'Hero')),
  preset('hero-left', 'hero', 'Hero · left aligned', 'Headline on the left, room for a background image.', (c, tone) => node('hero', { eyebrow: '', title: c('heroTitle'), subtitle: c('heroSub'), ctaLabel: c('demo'), ctaHref: '/demo', mediaId: '', align: 'left' }, [], TONE_STYLES[tone], 'Hero')),
  preset('hero-split', 'hero', 'Hero · text and image', 'Headline and buttons next to a product image.', (c, tone) =>
    band(tone, [columns([heading(c('heroTitle'), 1, 'left', { fontSize: '52px', lineHeight: '1.1' }), text('left', c('heroSub')), group('row', [button(c('start'), '/signup'), button(c('demo'), '/demo', 'secondary')], { gap: 'sm' })], [image(c('heroTitle'))])], 'Hero', 'wide', 'xl')),
  preset('hero-gradient', 'hero', 'Hero · gradient', 'Centred headline on a colourful gradient.', (c, tone) =>
    node('section', { background: 'default', paddingY: 'xl', width: 'narrow', anchor: '' }, [heading(c('heroTitle'), 1, 'center', { fontSize: '56px', lineHeight: '1.05', letterSpacing: '-0.02em' }), text('center', c('heroSub')), group('row', [button(c('start'), '/signup'), button(c('learn'), '#features', 'secondary')], { gap: 'sm', align: 'center' }, { justifyContent: 'center' })], { backgroundImage: GRADIENTS[tone], color: tone === 'light' || tone === 'muted' ? '#0B0D12' : '#ffffff' }, 'Hero')),
  // features
  preset('features-3', 'features', 'Features · three columns', 'Three benefits with short descriptions.', (c, tone) => band(tone, [node('features', { title: c('featuresTitle'), columns: 3, items: tf(c, 3) })], 'Features', 'wide')),
  preset('features-4', 'features', 'Features · four columns', 'Four compact benefits.', (c, tone) => band(tone, [node('features', { title: c('featuresTitle'), columns: 4, items: tf(c, 4) })], 'Features', 'wide')),
  preset('features-2', 'features', 'Features · two columns', 'Two larger benefits.', (c, tone) => band(tone, [node('features', { title: c('featuresTitle'), columns: 2, items: tf(c, 2) })], 'Features')),
  preset('features-image', 'features', 'Feature · image and text', 'One benefit explained next to an image.', (c, tone) => band(tone, [columns([image(c('f1'))], [heading(c('f1'), 2), text('left', c('f1t'), c('f3t')), button(c('learn'), '/features', 'link')])], 'Feature', 'wide')),
  preset('steps', 'features', 'How it works · three steps', 'Numbered steps in cards.', (c, tone) =>
    band(tone, [heading(c('stepsTitle'), 2, 'center'), group('grid', (['step1', 'step2', 'step3'] as const).map((k, i) => card([heading(`${i + 1}`, 3, 'left', { fontSize: '32px', color: 'token:primary' }), heading(c(k), 4), text('left', c('stepT'))])), { columns: 3 })], 'Steps', 'wide')),
  // proof
  preset('stats-band', 'proof', 'Stats band', 'A headline and three big numbers.', (c, tone) => band(tone, [heading(c('statsTitle'), 2, 'center'), node('stats', { items: [{ value: '10 000+', label: c('s1') }, { value: '99.9%', label: c('s2') }, { value: '40', label: c('s3') }] })], 'Stats')),
  preset('logos', 'proof', 'Logo strip', 'A row of customer names (swap in logos).', (c, tone) =>
    band(tone, [heading(c('logos'), 4, 'center', { textTransform: 'uppercase', letterSpacing: '0.1em', opacity: '0.7' }), group('row', ['Northwind', 'Contoso', 'Globex', 'Initech', 'Umbrella'].map((n) => heading(n, 3, 'center', { opacity: '0.6' })), { gap: 'lg', align: 'center' }, { justifyContent: 'center' })], 'Logos', 'wide', 'md')),
  preset('testimonial', 'proof', 'Testimonial', 'One customer quote with name and role.', (c, tone) => band(tone, [node('testimonial', { quote: c('quote'), name: c('quoteName'), role: c('quoteRole'), mediaId: '' })], 'Testimonial', 'narrow')),
  preset('testimonials-3', 'proof', 'Testimonials · grid', 'Three quotes side by side.', (c, tone) => band(tone, [group('grid', [0, 1, 2].map(() => node('testimonial', { quote: c('quote'), name: c('quoteName'), role: c('quoteRole'), mediaId: '' })), { columns: 3 })], 'Testimonials', 'wide')),
  preset('quote-big', 'proof', 'Big quote', 'A large pull quote.', (c, tone) => band(tone, [node('quote', { text: c('quote'), author: c('quoteName'), role: c('quoteRole') })], 'Quote', 'narrow')),
  // pricing
  preset('pricing-3', 'pricing', 'Pricing · three plans', 'Three plan cards, the middle one highlighted.', (c, tone) =>
    band(tone, [heading(c('pricingTitle'), 2, 'center'), text('center', c('pricingSub')), group('grid', [plan(c, 'planStarter', '$0', 'planStarterT'), plan(c, 'planPro', '$29', 'planProT', true), plan(c, 'planTeam', '$99', 'planTeamT')], { columns: 3 })], 'Pricing', 'wide')),
  preset('pricing-2', 'pricing', 'Pricing · two plans', 'Free and paid plan cards.', (c, tone) => band(tone, [heading(c('pricingTitle'), 2, 'center'), group('grid', [plan(c, 'planStarter', '$0', 'planStarterT'), plan(c, 'planPro', '$29', 'planProT', true)], { columns: 2 })], 'Pricing')),
  // cta
  preset('cta-band', 'cta', 'Call to action · band', 'Headline, sentence and a button on colour.', (c, tone) => node('cta', { title: c('ctaTitle'), text: c('ctaText'), buttonLabel: c('start'), buttonHref: '/signup', tone: tone === 'dark' ? 'dark' : tone === 'brand' ? 'primary' : 'muted' }, [], tone === 'light' ? TONE_STYLES.light : undefined, 'CTA')),
  preset('cta-split', 'cta', 'Call to action · split', 'Text on the left, buttons on the right.', (c, tone) => band(tone, [columns([heading(c('ctaTitle'), 2), text('left', c('ctaText'))], [group('row', [button(c('start'), '/signup'), button(c('demo'), '/demo', 'secondary')], { gap: 'sm' }, { justifyContent: 'flex-end' })])], 'CTA', 'wide')),
  preset('newsletter', 'cta', 'Newsletter sign-up', 'A short pitch with a form (pick the form after inserting).', (c, tone) => band(tone, [heading(c('newsletter'), 2, 'center'), text('center', c('newsletterT')), node('form', { formId: '', title: '', intro: '', submitLabel: c('subscribe'), layout: 'stacked' })], 'Newsletter', 'narrow')),
  // faq
  preset('faq', 'faq', 'FAQ', 'Expandable questions and answers.', (c, tone) => band(tone, [node('faq', { title: c('faqTitle'), items: [{ q: c('q1'), a: c('a1') }, { q: c('q2'), a: c('a2') }, { q: c('q3'), a: c('a3') }] })], 'FAQ', 'narrow')),
  preset('faq-split', 'faq', 'FAQ · with intro', 'Intro and contact button next to the questions.', (c, tone) =>
    band(tone, [columns([heading(c('faqTitle'), 2), text('left', c('faqSide')), button(c('contactUs'), '/contact', 'secondary')], [node('faq', { title: '', items: [{ q: c('q1'), a: c('a1') }, { q: c('q2'), a: c('a2') }, { q: c('q3'), a: c('a3') }] })])], 'FAQ', 'wide')),
  // team & about
  preset('team', 'team', 'Team grid', 'Photos, names and roles.', (c, tone) => band(tone, [heading(c('teamTitle'), 2, 'center'), group('grid', [0, 1, 2, 3].map(() => group('stack', [image(c('member'), { borderRadius: '9999px' }), heading(c('member'), 4, 'center'), text('center', c('role'))], { gap: 'sm', align: 'center' })), { columns: 4 })], 'Team', 'wide')),
  preset('about', 'team', 'About · story', 'Your story next to an image.', (c, tone) => band(tone, [columns([heading(c('storyTitle'), 2), text('left', c('story1'), c('story2'))], [image(c('storyTitle'))])], 'About', 'wide')),
  // contact
  preset('contact', 'contact', 'Contact · form', 'Contact details next to a form.', (c, tone) => band(tone, [columns([heading(c('contactTitle'), 2), text('left', c('contactText'), c('contactHours'))], [node('form', { formId: '', title: '', intro: '', submitLabel: c('send'), layout: 'card' })])], 'Contact', 'wide')),
  // content
  preset('video', 'content', 'Video feature', 'Headline and an embedded video.', (c, tone) => band(tone, [heading(c('videoTitle'), 2, 'center'), text('center', c('videoText')), node('video', { url: '', title: c('videoTitle') })], 'Video')),
  preset('gallery', 'content', 'Image gallery', 'Six images in a grid.', (c, tone) => band(tone, [heading(c('galleryTitle'), 2), group('grid', [0, 1, 2, 3, 4, 5].map(() => image(c('galleryTitle'))), { columns: 3, gap: 'sm' })], 'Gallery', 'wide')),
  preset('article', 'content', 'Article', 'Headline, lead, image and body text.', (c, tone) => band(tone, [heading(c('articleTitle'), 1, 'left', { fontSize: '44px', lineHeight: '1.15' }), text('left', c('articleLead')), image(c('articleTitle')), text('left', c('articleBody'), c('articleBody'))], 'Article', 'narrow')),
  // navigation
  preset('header', 'navigation', 'Header · navigation', 'Brand, links and a sign-up button.', (c, tone) =>
    band(tone, [group('row', [heading(c('brand'), 4), group('row', [button(c('product'), '/product', 'link'), button(c('resources'), '/resources', 'link'), button(c('login'), '/login', 'link'), button(c('start'), '/signup')], { gap: 'sm', align: 'center' })], { align: 'center' }, { justifyContent: 'space-between' })], 'Header', 'wide', 'md')),
  preset('footer', 'navigation', 'Footer · columns', 'Four link columns and a copyright line.', (c, tone) =>
    band(tone, [group('grid', ([['product', 'links1'], ['company', 'links2'], ['resources', 'links3'], ['legal', 'links4']] as const).map(([h, l]) => group('stack', [heading(c(h), 4), text('left', c(l))], { gap: 'sm' })), { columns: 4 }), node('divider', { style: 'solid' }), text('left', c('copyright'))], 'Footer', 'wide', 'md')),
];

// ── layout families ─────────────────────────────────────────────────────────
// Variations that change the layout itself (alignment, image side, columns, card style, button
// set), each a distinct block in the library; tones are applied on top of every one of them.

type CardStyle = 'flat' | 'outlined' | 'shadow' | 'numbered' | 'tinted';
const CARD: Record<CardStyle, StyleProps> = {
  flat: {},
  outlined: { borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgb(127 127 127 / 0.3)', borderRadius: '16px', paddingTop: '24px', paddingBottom: '24px', paddingLeft: '24px', paddingRight: '24px' },
  shadow: { backgroundColor: 'token:background', color: 'token:foreground', borderRadius: '16px', boxShadow: '0 12px 32px -12px rgba(0,0,0,0.25)', paddingTop: '28px', paddingBottom: '28px', paddingLeft: '28px', paddingRight: '28px' },
  numbered: { borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgb(127 127 127 / 0.2)', borderRadius: '12px', paddingTop: '20px', paddingBottom: '20px', paddingLeft: '20px', paddingRight: '20px' },
  tinted: { backgroundColor: 'rgb(139 124 255 / 0.12)', borderRadius: '20px', paddingTop: '28px', paddingBottom: '28px', paddingLeft: '28px', paddingRight: '28px' },
};
const CARD_NAME: Record<CardStyle, [string, string]> = { flat: ['plain', 'просто'], outlined: ['outlined', 'с рамкой'], shadow: ['cards with shadow', 'карточки с тенью'], numbered: ['numbered', 'с номерами'], tinted: ['tinted', 'с подложкой'] };
const featureCards = (c: (k: keyof typeof T) => string, n: number, style: CardStyle) =>
  Array.from({ length: n }, (_, i) => {
    const k = (['f1', 'f2', 'f3', 'f4'] as const)[i % 4]!;
    const kids: BlockNode[] = [];
    if (style === 'numbered') kids.push(heading(String(i + 1).padStart(2, '0'), 3, 'left', { color: 'token:primary', fontSize: '28px' }));
    kids.push(heading(c(k), 3), text('left', c(`${k}t` as keyof typeof T)));
    return group('stack', kids, { gap: 'sm' }, CARD[style]);
  });

// Heroes: alignment × media × buttons.
for (const align of ['left', 'center'] as const) {
  for (const media of ['none', 'right', 'left', 'band'] as const) {
    if (align === 'center' && (media === 'right' || media === 'left')) continue;
    for (const buttons of [1, 2] as const) {
      const key = `hero-${align}-${media}-${buttons}`;
      const name = `Hero · ${align === 'left' ? 'left' : 'centred'}${media === 'none' ? '' : media === 'band' ? ', image below' : `, image ${media}`}${buttons === 2 ? ', two buttons' : ''}`;
      SECTION_PRESETS.push(
        preset(key, 'hero', name, 'Headline, subtitle and call to action in a different arrangement.', (c, tone) => {
          const btns = group('row', buttons === 2 ? [button(c('start'), '/signup', 'primary', align), button(c('demo'), '/demo', 'secondary', align)] : [button(c('start'), '/signup', 'primary', align)], { gap: 'sm', align: 'center' }, align === 'center' ? { justifyContent: 'center' } : undefined);
          const copy = [heading(c('heroTitle'), 1, align, { fontSize: '54px', lineHeight: '1.08', letterSpacing: '-0.02em' }), text(align, c('heroSub')), btns];
          if (media === 'none') return band(tone, copy, 'Hero', 'default', 'xl');
          if (media === 'band') return band(tone, [...copy, image(c('heroTitle'), { marginTop: '32px', borderRadius: '20px' })], 'Hero', 'wide', 'xl');
          const pic = [image(c('heroTitle'), { borderRadius: '20px' })];
          return band(tone, [media === 'right' ? columns(copy, pic) : columns(pic, copy)], 'Hero', 'wide', 'xl');
        }),
      );
    }
  }
}

// Features: columns × card style.
for (const cols of [2, 3, 4] as const) {
  for (const style of ['flat', 'outlined', 'shadow', 'numbered', 'tinted'] as const) {
    SECTION_PRESETS.push(
      preset(`features-${cols}-${style}`, 'features', `Features · ${cols} columns, ${CARD_NAME[style][0]}`, 'A grid of benefits with a heading.', (c, tone) =>
        band(tone, [heading(c('featuresTitle'), 2, 'center'), group('grid', featureCards(c, cols === 2 ? 4 : cols, style), { columns: cols, gap: 'lg' })], 'Features', 'wide'),
      ),
    );
  }
}

// Text and image: image side × with a button or a list of points.
for (const side of ['left', 'right'] as const) {
  for (const extra of ['button', 'points', 'quote'] as const) {
    SECTION_PRESETS.push(
      preset(`split-${side}-${extra}`, 'content', `Text and image · image ${side}, ${extra === 'button' ? 'with a button' : extra === 'points' ? 'with points' : 'with a quote'}`, 'A heading and copy next to an image.', (c, tone) => {
        const tail = extra === 'button' ? button(c('learn'), '/about', 'secondary') : extra === 'points' ? text('left', `✓ ${c('f1t')}`, `✓ ${c('f2t')}`, `✓ ${c('f3t')}`) : node('quote', { text: c('quote'), author: c('quoteName'), role: c('quoteRole') });
        const copy = [heading(c('storyTitle'), 2), text('left', c('story1')), tail];
        const pic = [image(c('storyTitle'), { borderRadius: '16px' })];
        return band(tone, [side === 'right' ? columns(copy, pic) : columns(pic, copy)], 'Text and image', 'wide');
      }),
    );
  }
}

// Social proof: testimonials and stats in several layouts.
for (const n of [2, 3] as const) {
  for (const style of ['outlined', 'shadow', 'tinted'] as const) {
    SECTION_PRESETS.push(
      preset(`reviews-${n}-${style}`, 'proof', `Reviews · ${n} in a row, ${CARD_NAME[style][0]}`, 'Customer quotes in cards.', (c, tone) =>
        band(tone, [heading(c('statsTitle'), 2, 'center'), group('grid', Array.from({ length: n }, () => group('stack', [text('left', `“${c('quote')}”`), heading(c('quoteName'), 4), text('left', c('quoteRole'))], { gap: 'sm' }, CARD[style])), { columns: n, gap: 'lg' })], 'Reviews', 'wide'),
      ),
    );
  }
}
for (const style of ['flat', 'shadow', 'tinted'] as const) {
  SECTION_PRESETS.push(
    preset(`numbers-4-${style}`, 'proof', `Numbers · four, ${CARD_NAME[style][0]}`, 'Four big numbers with labels.', (c, tone) =>
      band(tone, [group('grid', (['s1', 's2', 's3', 's1'] as const).map((k, i) => group('stack', [heading(['10 000+', '99.9%', '40', '24/7'][i]!, 2, 'center', { fontSize: '44px', color: 'token:primary' }), text('center', c(k))], { gap: 'sm', align: 'center' }, CARD[style])), { columns: 4, gap: 'md' })], 'Numbers', 'wide', 'md'),
    ),
  );
}

// Pricing: number of plans × card style.
for (const n of [2, 3, 4] as const) {
  for (const style of ['outlined', 'shadow'] as const) {
    if (n !== 4 && style === 'outlined') continue; // the base presets cover these
    SECTION_PRESETS.push(
      preset(`pricing-${n}-${style}`, 'pricing', `Pricing · ${n} plans, ${CARD_NAME[style][0]}`, 'Plan cards with prices and a button each.', (c, tone) => {
        const plans: [keyof typeof T, string, keyof typeof T][] = [['planStarter', '$0', 'planStarterT'], ['planPro', '$29', 'planProT'], ['planTeam', '$99', 'planTeamT'], ['planTeam', '$249', 'planTeamT']];
        return band(tone, [heading(c('pricingTitle'), 2, 'center'), text('center', c('pricingSub')), group('grid', plans.slice(0, n).map(([nm, price, f], i) => group('stack', [heading(i === 3 ? 'Enterprise' : c(nm), 3), heading(price, 2, 'left', { fontSize: '40px' }), text('left', c('perMonth')), text('left', c(f)), button(c('choose'), '/signup', i === 1 ? 'primary' : 'secondary')], { gap: 'sm' }, CARD[style])), { columns: n, gap: 'md' })], 'Pricing', 'wide');
      }),
    );
  }
}

// Calls to action.
for (const layout of ['centered', 'boxed', 'image'] as const) {
  SECTION_PRESETS.push(
    preset(`cta-${layout}`, 'cta', `Call to action · ${layout === 'centered' ? 'centred' : layout === 'boxed' ? 'boxed card' : 'with image'}`, 'A short pitch and a button.', (c, tone) => {
      if (layout === 'image') return band(tone, [columns([heading(c('ctaTitle'), 2), text('left', c('ctaText')), button(c('start'), '/signup')], [image(c('ctaTitle'), { borderRadius: '16px' })])], 'CTA', 'wide');
      const inner = [heading(c('ctaTitle'), 2, 'center'), text('center', c('ctaText')), group('row', [button(c('start'), '/signup', 'primary', 'center')], { align: 'center' }, { justifyContent: 'center' })];
      return band(tone, layout === 'boxed' ? [group('stack', inner, { gap: 'md', align: 'center' }, { ...CARD.tinted, paddingTop: '48px', paddingBottom: '48px' })] : inner, 'CTA', 'default');
    }),
  );
}

// Team, gallery, contact, navigation variations.
for (const cols of [3, 4] as const) {
  for (const photo of ['circle', 'square'] as const) {
    if (cols === 4 && photo === 'circle') continue; // = the base "team" preset
    SECTION_PRESETS.push(
      preset(`team-${cols}-${photo}`, 'team', `Team · ${cols} people, ${photo} photos`, 'Photos, names and roles.', (c, tone) =>
        band(tone, [heading(c('teamTitle'), 2, 'center'), group('grid', Array.from({ length: cols }, () => group('stack', [image(c('member'), { borderRadius: photo === 'circle' ? '9999px' : '16px' }), heading(c('member'), 4, 'center'), text('center', c('role'))], { gap: 'sm', align: 'center' })), { columns: cols })], 'Team', 'wide'),
      ),
    );
  }
}
for (const cols of [2, 4] as const) {
  SECTION_PRESETS.push(preset(`gallery-${cols}`, 'content', `Image gallery · ${cols} columns`, 'Images in a grid.', (c, tone) => band(tone, [heading(c('galleryTitle'), 2), group('grid', Array.from({ length: cols * 2 }, () => image(c('galleryTitle'), { borderRadius: '12px' })), { columns: cols, gap: 'sm' })], 'Gallery', 'wide')));
}
SECTION_PRESETS.push(
  preset('contact-left', 'contact', 'Contact · form on the left', 'A form next to contact details.', (c, tone) => band(tone, [columns([node('form', { formId: '', title: '', intro: '', submitLabel: c('send'), layout: 'card' })], [heading(c('contactTitle'), 2), text('left', c('contactText'), c('contactHours'))])], 'Contact', 'wide')),
  preset('contact-details', 'contact', 'Contact · details only', 'Address, phone and hours in three columns.', (c, tone) => band(tone, [heading(c('contactTitle'), 2, 'center'), group('grid', [text('center', c('contactText')), text('center', c('contactHours')), button(c('contactUs'), 'mailto:hello@example.com', 'primary', 'center')], { columns: 3, align: 'center' })], 'Contact', 'wide')),
  preset('header-centered', 'navigation', 'Header · centred logo', 'The brand in the middle, links below.', (c, tone) => band(tone, [heading(c('brand'), 3, 'center'), group('row', [button(c('product'), '/product', 'link'), button(c('resources'), '/resources', 'link'), button(c('company'), '/about', 'link')], { gap: 'md', align: 'center' }, { justifyContent: 'center' })], 'Header', 'wide', 'md')),
  preset('footer-simple', 'navigation', 'Footer · one line', 'Brand, links and copyright on one line.', (c, tone) => band(tone, [group('row', [heading(c('brand'), 4), text('left', c('links4')), text('left', c('copyright'))], { align: 'center', gap: 'lg' }, { justifyContent: 'space-between' })], 'Footer', 'wide', 'md')),
  preset('faq-two-columns', 'faq', 'FAQ · two columns', 'Questions split into two columns.', (c, tone) => band(tone, [heading(c('faqTitle'), 2, 'center'), columns([node('faq', { title: '', items: [{ q: c('q1'), a: c('a1') }, { q: c('q2'), a: c('a2') }] })], [node('faq', { title: '', items: [{ q: c('q3'), a: c('a3') }, { q: c('q1'), a: c('a1') }] })])], 'FAQ', 'wide')),
);

// Russian names of the family variants, built from the same parameters as their keys.
const RU_FIXED: Record<string, string> = {
  'cta-centered': 'Призыв · по центру',
  'cta-boxed': 'Призыв · в карточке',
  'cta-image': 'Призыв · с картинкой',
  'contact-left': 'Контакты · форма слева',
  'contact-details': 'Контакты · только данные',
  'header-centered': 'Шапка · логотип по центру',
  'footer-simple': 'Подвал · в одну строку',
  'faq-two-columns': 'Вопросы · в две колонки',
};
const plural = (n: number, one: string, few: string, many: string) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
for (const p of SECTION_PRESETS) {
  if (p.nameRu) continue;
  const k = p.key.split('-');
  const card = (x: string) => CARD_NAME[x as CardStyle]?.[1] ?? x;
  if (RU_FIXED[p.key]) p.nameRu = RU_FIXED[p.key];
  else if (k[0] === 'hero' && k.length === 4) p.nameRu = `Первый экран · ${k[1] === 'left' ? 'слева' : 'по центру'}${k[2] === 'none' ? '' : k[2] === 'band' ? ', картинка снизу' : `, картинка ${k[2] === 'right' ? 'справа' : 'слева'}`}${k[3] === '2' ? ', две кнопки' : ''}`;
  else if (k[0] === 'features' && k.length === 3) p.nameRu = `Преимущества · ${k[1]} ${plural(Number(k[1]), 'колонка', 'колонки', 'колонок')}, ${card(k[2]!)}`;
  else if (k[0] === 'split') p.nameRu = `Текст и фото · фото ${k[1] === 'left' ? 'слева' : 'справа'}, ${k[2] === 'button' ? 'с кнопкой' : k[2] === 'points' ? 'со списком' : 'с цитатой'}`;
  else if (k[0] === 'reviews') p.nameRu = `Отзывы · ${k[1]} в ряд, ${card(k[2]!)}`;
  else if (k[0] === 'numbers') p.nameRu = `Цифры · четыре, ${card(k[2]!)}`;
  else if (k[0] === 'pricing' && k.length === 3) p.nameRu = `Тарифы · ${k[1]} ${plural(Number(k[1]), 'план', 'плана', 'планов')}, ${card(k[2]!)}`;
  else if (k[0] === 'team' && k.length === 3) p.nameRu = `Команда · ${k[1]} ${plural(Number(k[1]), 'человек', 'человека', 'человек')}, ${k[2] === 'circle' ? 'круглые фото' : 'квадратные фото'}`;
  else if (k[0] === 'gallery' && k.length === 2) p.nameRu = `Галерея · ${k[1]} ${plural(Number(k[1]), 'колонка', 'колонки', 'колонок')}`;
}

// ── free-form compositions ──────────────────────────────────────────────────

type Box = { left: number; top: number; width: number; height?: number };
/** Desktop box plus a stacked mobile box (Mobile L, 430 px; Mobile S follows with a narrower width). */
const at = (desk: Box, mob: Box, extra: StyleProps = {}): BlockNode['styles'] => ({
  base: { position: 'absolute', left: `${desk.left}px`, top: `${desk.top}px`, width: `${desk.width}px`, ...(desk.height ? { height: `${desk.height}px` } : {}), maxWidth: 'none', marginTop: '0px', paddingLeft: '0px', paddingRight: '0px', ...extra },
  mobileL: { left: `${mob.left}px`, top: `${mob.top}px`, width: `${mob.width}px`, ...(mob.height ? { height: `${mob.height}px` } : {}) },
  mobileS: { width: `${Math.min(mob.width, 343)}px` },
});
const free = (tone: SectionTone, height: number, mobileHeight: number, children: BlockNode[], name: string): BlockNode => ({
  ...node('canvas', { height, frame: 'grid', background: 'default' }, children, undefined, name),
  styles: { base: TONE_STYLES[tone], mobileL: { minHeight: `${mobileHeight}px` } },
});
const el = (type: string, props: Record<string, unknown>, styles: BlockNode['styles']): BlockNode => ({ ...node(type, props), styles });

SECTION_PRESETS.push(
  preset('free-collage', 'freeform', 'Free-form · collage hero', 'Headline and button next to overlapping shapes and an image — move anything.', (c, tone) =>
    free(tone, 640, 860, [
      el('shape', { kind: 'circle' }, at({ left: 700, top: 60, width: 420, height: 420 }, { left: 140, top: 520, width: 260, height: 260 }, { backgroundColor: 'token:primary', opacity: '0.18' })),
      el('image', { mediaId: '', alt: c('heroTitle'), caption: '', rounded: true }, at({ left: 760, top: 150, width: 340 }, { left: 40, top: 560, width: 300 }, { borderRadius: '24px' })),
      el('heading', { text: c('heroTitle'), level: 1, align: 'left' }, at({ left: 40, top: 140, width: 600 }, { left: 16, top: 48, width: 398 }, { fontSize: '60px', lineHeight: '1.05', letterSpacing: '-0.02em' })),
      el('text', { doc: doc(c('heroSub')), align: 'left' }, at({ left: 40, top: 360, width: 500 }, { left: 16, top: 300, width: 398 })),
      el('button', { label: c('start'), href: '/signup', variant: 'primary', align: 'left' }, at({ left: 40, top: 470, width: 220 }, { left: 16, top: 430, width: 220 })),
    ], 'Collage'),
  ),
  preset('free-poster', 'freeform', 'Free-form · poster', 'One huge word, a line and a caption, set like a poster.', (c, tone) =>
    free(tone, 560, 520, [
      el('heading', { text: c('heroTitle'), level: 1, align: 'left' }, at({ left: 40, top: 80, width: 1100 }, { left: 16, top: 48, width: 398 }, { fontSize: '96px', lineHeight: '0.95', letterSpacing: '-0.04em', textTransform: 'uppercase' })),
      el('shape', { kind: 'line' }, at({ left: 40, top: 400, width: 1120, height: 2 }, { left: 16, top: 330, width: 398, height: 2 }, { backgroundColor: 'token:primary', opacity: '1' })),
      el('text', { doc: doc(c('heroSub')), align: 'left' }, at({ left: 40, top: 430, width: 520 }, { left: 16, top: 352, width: 398 })),
      el('button', { label: c('learn'), href: '#more', variant: 'link', align: 'left' }, at({ left: 960, top: 440, width: 200 }, { left: 16, top: 452, width: 200 })),
    ], 'Poster'),
  ),
  preset('free-cards', 'freeform', 'Free-form · floating cards', 'Three offset cards over a soft background shape.', (c, tone) => {
    const cards = (['f1', 'f2', 'f3'] as const).flatMap((k, i) => {
      const d = { left: 40 + i * 380, top: 140 + (i % 2) * 60 };
      const m = { left: 16, top: 140 + i * 200 };
      return [
        el('shape', { kind: 'rectangle' }, at({ ...d, width: 340, height: 220 }, { ...m, width: 398, height: 180 }, { backgroundColor: 'token:background', borderRadius: '20px', boxShadow: '0 20px 40px -12px rgba(0,0,0,0.25)', opacity: '1' })),
        el('heading', { text: c(k), level: 3, align: 'left' }, at({ left: d.left + 28, top: d.top + 32, width: 280 }, { left: m.left + 24, top: m.top + 28, width: 340 }, { color: 'token:foreground' })),
        el('text', { doc: doc(c(`${k}t` as keyof typeof T)), align: 'left' }, at({ left: d.left + 28, top: d.top + 90, width: 280 }, { left: m.left + 24, top: m.top + 80, width: 340 }, { color: 'token:foreground', fontSize: '16px' })),
      ];
    });
    return free(tone, 520, 780, [
      el('heading', { text: c('featuresTitle'), level: 2, align: 'left' }, at({ left: 40, top: 40, width: 800 }, { left: 16, top: 40, width: 398 })),
      ...cards,
    ], 'Cards');
  }),
  preset('free-quote', 'freeform', 'Free-form · big quote', 'An oversized quotation mark behind a customer quote.', (c, tone) =>
    free(tone, 460, 520, [
      el('heading', { text: '“', level: 2, align: 'left' }, at({ left: 20, top: -40, width: 300 }, { left: 8, top: -20, width: 200 }, { fontSize: '320px', lineHeight: '1', color: 'token:primary', opacity: '0.25' })),
      el('heading', { text: c('quote'), level: 2, align: 'left' }, at({ left: 160, top: 120, width: 880 }, { left: 16, top: 120, width: 398 }, { fontSize: '40px', lineHeight: '1.2' })),
      el('text', { doc: doc(`${c('quoteName')} · ${c('quoteRole')}`), align: 'left' }, at({ left: 160, top: 320, width: 600 }, { left: 16, top: 400, width: 398 }, { opacity: '0.7' })),
    ], 'Quote'),
  ),
);

// ── media heroes (stock photo and video by link) ────────────────────────────
// Every photo and clip was looked at before being listed; they are free stock (Unsplash photos,
// Mixkit videos under the Mixkit free licence) shown by link until the site swaps in its own.

const photo = (id: string, w = 1920) => `https://images.unsplash.com/${id}?auto=format&fit=crop&q=80&w=${w}`;
// The clip's own first frame, so a preview (and a visitor before the video loads) sees that video.
const still = (id: number) => `https://assets.mixkit.co/videos/${id}/${id}-thumb-720-0.jpg`;
const clip = (id: number) => `https://assets.mixkit.co/videos/${id}/${id}-720.mp4`;

export const STOCK_PHOTOS = {
  forest: photo('photo-1731690415686-e68f78e2b5bd'),
  team: photo('photo-1600880292203-757bb62b4baf'),
  interior: photo('photo-1524758631624-e2822e304c36'),
  music: photo('photo-1484959014842-cd1d967a39cf'),
  graduate: photo('photo-1464582883107-8adf2dca8a9f'),
  plant: photo('photo-1485955900006-10f4d324d411'),
  exhibition: photo('photo-1588515724527-074a7a56616c'),
  workspace: photo('photo-1661956602116-aa6865609028'),
  paint: photo('photo-1605721911519-3dfeb3be25e7'),
} as const;

export const STOCK_VIDEOS = {
  meeting: { url: clip(4809), poster: still(4809) },
  office: { url: clip(914), poster: still(914) },
  city: { url: clip(41541), poster: still(41541) },
  lights: { url: clip(30), poster: still(30) },
  ink: { url: clip(44818), poster: still(44818) },
  clouds: { url: clip(14165), poster: still(14165) },
  waterfall: { url: clip(2213), poster: still(2213) },
  sunset: { url: clip(51445), poster: still(51445) },
  sunflowers: { url: clip(4881), poster: still(4881) },
  typing: { url: clip(1781), poster: still(1781) },
} as const;

const VIDEO_NAMES: Record<keyof typeof STOCK_VIDEOS, [string, string]> = {
  meeting: ['business meeting', 'деловая встреча'],
  office: ['open office', 'офис'],
  city: ['city from above', 'город с высоты'],
  lights: ['night lights', 'ночные огни'],
  ink: ['flowing ink', 'чернила'],
  clouds: ['through the clouds', 'сквозь облака'],
  waterfall: ['waterfall', 'водопад'],
  sunset: ['sunset by the sea', 'закат у моря'],
  sunflowers: ['sunflower field', 'поле подсолнухов'],
  typing: ['working on a laptop', 'работа за ноутбуком'],
};
const PHOTO_NAMES: Record<keyof typeof STOCK_PHOTOS, [string, string]> = {
  forest: ['forest walk', 'лес'],
  team: ['team at work', 'команда'],
  interior: ['bright interior', 'интерьер'],
  music: ['musician', 'музыкант'],
  graduate: ['graduation', 'выпускница'],
  plant: ['minimal still life', 'минимализм'],
  exhibition: ['exhibition', 'выставка'],
  workspace: ['workspace', 'рабочее место'],
  paint: ['abstract painting', 'абстракция'],
};

(Object.keys(STOCK_VIDEOS) as (keyof typeof STOCK_VIDEOS)[]).forEach((k, i) => {
  const v = STOCK_VIDEOS[k];
  const pr = preset(`hero-video-${k}`, 'hero', `Hero · video: ${VIDEO_NAMES[k][0]}`, 'A headline over a silent looping background video.', (c) =>
    node('hero', { eyebrow: c('eyebrow'), title: c('heroTitle'), subtitle: c('heroSub'), ctaLabel: c('start'), ctaHref: '/signup', mediaId: '', imageUrl: v.poster, videoUrl: v.url, overlay: 'dark', align: i % 2 ? 'left' : 'center' }, [], { minHeight: '640px', paddingTop: '48px' }, 'Hero'),
  );
  pr.nameRu = `Первый экран · видео: ${VIDEO_NAMES[k][1]}`;
  SECTION_PRESETS.push(pr);
});
(Object.keys(STOCK_PHOTOS) as (keyof typeof STOCK_PHOTOS)[]).forEach((k, i) => {
  const pr = preset(`hero-photo-${k}`, 'hero', `Hero · photo: ${PHOTO_NAMES[k][0]}`, 'A headline over a full-width photo.', (c) =>
    node('hero', { eyebrow: '', title: c('heroTitle'), subtitle: c('heroSub'), ctaLabel: c(i % 2 ? 'demo' : 'start'), ctaHref: '/signup', mediaId: '', imageUrl: STOCK_PHOTOS[k], videoUrl: '', overlay: k === 'plant' || k === 'interior' ? 'light' : 'dark', align: i % 3 === 0 ? 'left' : 'center' }, [], { minHeight: '560px' }, 'Hero'),
  );
  pr.nameRu = `Первый экран · фото: ${PHOTO_NAMES[k][1]}`;
  SECTION_PRESETS.push(pr);
});
// Free-form over video: elements placed by hand on top of a moving background.
(['ink', 'city', 'sunset'] as const).forEach((k) => {
  const v = STOCK_VIDEOS[k];
  const pr = preset(`free-video-${k}`, 'freeform', `Free-form · over video: ${VIDEO_NAMES[k][0]}`, 'Headline, text and button positioned freely over a background video.', (c) => ({
    ...node('canvas', { height: 680, frame: 'grid', background: 'dark', imageUrl: v.poster, videoUrl: v.url, overlay: 'dark' }, [
      // Staggered entrance: headline, then text, then the button.
      { ...el('heading', { text: c('heroTitle'), level: 1, align: 'left' }, at({ left: 40, top: 200, width: 760 }, { left: 16, top: 120, width: 398 }, { fontSize: '72px', lineHeight: '1.02', letterSpacing: '-0.03em', color: '#ffffff' })), animation: { type: 'slide-up', trigger: 'load' } },
      { ...el('text', { doc: doc(c('heroSub')), align: 'left' }, at({ left: 40, top: 400, width: 520 }, { left: 16, top: 400, width: 398 }, { color: '#ffffff', opacity: '0.85' })), animation: { type: 'slide-up', trigger: 'load', delay: 200 } },
      { ...el('button', { label: c('start'), href: '/signup', variant: 'primary', align: 'left' }, at({ left: 40, top: 500, width: 220 }, { left: 16, top: 520, width: 220 })), animation: { type: 'zoom-in', trigger: 'load', delay: 400, easing: 'spring', hover: 'lift' } },
      el('shape', { kind: 'line' }, at({ left: 40, top: 170, width: 120, height: 3 }, { left: 16, top: 96, width: 120, height: 3 }, { backgroundColor: 'token:primary', opacity: '1' })),
    ], undefined, 'Video'),
    styles: { mobileL: { minHeight: '640px' } },
  }));
  pr.nameRu = `Свободный · поверх видео: ${VIDEO_NAMES[k][1]}`;
  SECTION_PRESETS.push(pr);
});

/**
 * Whole-page templates: an ordered set of sections with tones, so a page can start complete.
 * Each section is a regular preset, so everything stays editable.
 */
export interface PageTemplate {
  key: string;
  name: string;
  description: string;
  build: (locale: string, tone: SectionTone) => BlockNode[];
}

const page = (key: string, name: string, description: string, parts: [string, SectionTone | 'same'][]): PageTemplate => ({
  key,
  name,
  description,
  build: (locale, tone) => parts.map(([k, t]) => getSectionPreset(k)!.build(locale, t === 'same' ? tone : t)),
});

export const PAGE_TEMPLATES: PageTemplate[] = [
  page('saas', 'Product landing', 'Hero, logos, features, steps, pricing, testimonials, FAQ and a call to action.', [['header', 'same'], ['hero-split', 'same'], ['logos', 'muted'], ['features-3', 'same'], ['steps', 'muted'], ['pricing-3', 'same'], ['testimonials-3', 'muted'], ['faq', 'same'], ['cta-band', 'brand'], ['footer', 'dark']]),
  page('startup', 'Bold startup', 'A cloud video hero, a collage, stats and a sign-up band.', [['header', 'same'], ['hero-video-clouds', 'same'], ['free-collage', 'same'], ['stats-band', 'muted'], ['features-4', 'same'], ['newsletter', 'muted'], ['footer', 'dark']]),
  page('agency', 'Agency', 'Poster headline, services, cases, team and contact.', [['header', 'same'], ['free-poster', 'same'], ['features-image', 'muted'], ['free-cards', 'same'], ['team', 'muted'], ['contact', 'same'], ['footer', 'dark']]),
  page('portfolio', 'Portfolio', 'About, gallery, quote and contact form.', [['header', 'same'], ['hero-left', 'same'], ['gallery', 'same'], ['free-quote', 'muted'], ['about', 'same'], ['contact', 'muted'], ['footer', 'dark']]),
  page('course', 'Online course', 'Course hero, programme, video, pricing, FAQ and sign-up.', [['header', 'same'], ['hero-centered', 'brand'], ['steps', 'same'], ['video', 'muted'], ['pricing-2', 'same'], ['faq-split', 'muted'], ['newsletter', 'same'], ['footer', 'dark']]),
  page('event', 'Event', 'A night-lights video, details, speakers, FAQ and registration.', [['hero-video-lights', 'dark'], ['stats-band', 'same'], ['team', 'muted'], ['faq', 'same'], ['cta-split', 'brand'], ['footer', 'dark']]),
  page('local', 'Local business', 'A team photo, services, reviews, prices and how to reach you.', [['header', 'same'], ['hero-photo-team', 'same'], ['features-3', 'same'], ['testimonial', 'muted'], ['pricing-3', 'same'], ['contact', 'muted'], ['footer', 'dark']]),
  page('about-page', 'About us', 'Story, numbers, team and an invitation.', [['header', 'same'], ['about', 'same'], ['stats-band', 'muted'], ['team', 'same'], ['quote-big', 'muted'], ['cta-band', 'brand'], ['footer', 'dark']]),
  page('pricing-page', 'Pricing page', 'Plans, comparison of benefits, FAQ and contact sales.', [['header', 'same'], ['pricing-3', 'same'], ['features-4', 'muted'], ['faq-split', 'same'], ['cta-split', 'brand'], ['footer', 'dark']]),
  page('contact-page', 'Contact page', 'Form, details and a short FAQ.', [['header', 'same'], ['contact', 'same'], ['faq', 'muted'], ['footer', 'dark']]),
  page('article-page', 'Article', 'An article with a newsletter sign-up.', [['header', 'same'], ['article', 'same'], ['newsletter', 'muted'], ['footer', 'dark']]),
  page('coming-soon', 'Coming soon', 'A poster and an e-mail sign-up.', [['free-poster', 'brand'], ['newsletter', 'same']]),
  page('video-landing', 'Video landing', 'A full-screen video hero, logos, features, reviews and sign-up.', [['header', 'dark'], ['hero-video-city', 'same'], ['logos', 'muted'], ['features-3-shadow', 'same'], ['reviews-3-shadow', 'muted'], ['pricing-3', 'same'], ['cta-band', 'brand'], ['footer', 'dark']]),
  page('creative-studio', 'Creative studio', 'Ink video under a free-form headline, work, team and contact.', [['free-video-ink', 'dark'], ['gallery-4', 'same'], ['split-right-quote', 'muted'], ['team-3-square', 'same'], ['contact-left', 'muted'], ['footer', 'dark']]),
  page('travel', 'Travel', 'A sunset video, destinations, reviews and booking.', [['header', 'same'], ['hero-video-sunset', 'same'], ['gallery', 'same'], ['reviews-2-tinted', 'muted'], ['faq', 'same'], ['newsletter', 'muted'], ['footer', 'dark']]),
  page('wellness', 'Wellness', 'A calm waterfall video, services, prices and contact.', [['header', 'same'], ['hero-video-waterfall', 'same'], ['features-3-tinted', 'same'], ['pricing-3-shadow', 'muted'], ['testimonial', 'same'], ['contact', 'muted'], ['footer', 'dark']]),
  page('interior-studio', 'Interior studio', 'A bright interior photo, services and portfolio.', [['header', 'same'], ['hero-photo-interior', 'same'], ['split-left-points', 'same'], ['gallery-2', 'muted'], ['cta-image', 'same'], ['footer', 'dark']]),
  page('school', 'School', 'A graduation photo, programmes, teachers and enrolment.', [['header', 'same'], ['hero-photo-graduate', 'same'], ['features-4-numbered', 'same'], ['team-4-square', 'muted'], ['faq-two-columns', 'same'], ['cta-boxed', 'muted'], ['footer', 'dark']]),
  page('music', 'Music teacher', 'A musician photo, lessons, prices and booking.', [['header', 'same'], ['hero-photo-music', 'same'], ['steps', 'muted'], ['pricing-2', 'same'], ['reviews-3-outlined', 'muted'], ['contact', 'same'], ['footer', 'dark']]),
  page('eco-farm', 'Farm and eco shop', 'Sunflowers on video, products, story and delivery.', [['header', 'same'], ['hero-video-sunflowers', 'same'], ['features-image', 'same'], ['about', 'muted'], ['faq-split', 'same'], ['footer', 'dark']]),
  page('business', 'Business services', 'A meeting video, services, numbers, team and contact.', [['header', 'same'], ['hero-video-meeting', 'same'], ['features-3-outlined', 'same'], ['numbers-4-shadow', 'muted'], ['team', 'same'], ['contact-details', 'muted'], ['footer', 'dark']]),
];

export function getSectionPreset(key: string): SectionPreset | undefined {
  return SECTION_PRESETS.find((p) => p.key === key);
}
