import { newId } from './edit';
import type { RichTextDoc } from './rich-text';
import type { StyleProps } from './styles';
import type { BlockNode } from './tree';

/**
 * Ready-made sections (Stage 4): whole page sections assembled from the regular blocks, so after
 * inserting everything is editable, styleable and translatable like hand-built content. Each
 * layout comes in four tones; copy exists in English and Russian (picked by the page locale).
 */

export const SECTION_CATEGORIES = ['hero', 'features', 'proof', 'pricing', 'cta', 'faq', 'team', 'contact', 'content', 'navigation'] as const;
export type SectionCategory = (typeof SECTION_CATEGORIES)[number];

export const SECTION_TONES = ['light', 'muted', 'dark', 'brand'] as const;
export type SectionTone = (typeof SECTION_TONES)[number];

export interface SectionPreset {
  key: string;
  category: SectionCategory;
  /** English name and description; the admin shows translated ones by key. */
  name: string;
  description: string;
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

export function getSectionPreset(key: string): SectionPreset | undefined {
  return SECTION_PRESETS.find((p) => p.key === key);
}
