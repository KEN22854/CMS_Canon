import { cloneWithIds } from '../edit';
import type { BlockNode } from '../tree';

/**
 * Sections converted from open-source templates (Tailblocks and HyperUI, both MIT; licences in this
 * folder). A separate entry point (`@canon/blocks/dist/vendor`), loaded on demand by the block
 * library, so the main bundle doesn't carry ~250 trees.
 *
 * The trees hold text placeholders ("[[h2]]", "[[p]]", "[[btn]]"…) which are filled with neutral
 * copy in the page's language when a section is inserted; prices and numbers are kept.
 */

export interface VendorPreset {
  key: string;
  category: string;
  name: string;
  nameRu: string;
  source: { name: 'Tailblocks' | 'HyperUI'; url: string; license: 'MIT'; file: string };
  build: (locale: string) => BlockNode;
}

const SOURCE_URL = { Tailblocks: 'https://github.com/mertJF/tailblocks', HyperUI: 'https://github.com/markmead/hyperui' } as const;

type Role = 'h1' | 'h2' | 'h3' | 'p' | 'label' | 'btn' | 'link';
const COPY: Record<'en' | 'ru', Record<Role, string[]>> = {
  en: {
    h1: ['Build something people love', 'Your work, beautifully presented', 'Grow faster with less effort', 'Everything your team needs', 'Made for people who make things'],
    h2: ['Why teams choose us', 'Features that make the difference', 'What our customers say', 'Simple, honest pricing', 'Get in touch', 'Latest stories', 'Meet the team', 'Numbers we are proud of', 'How it works', 'Questions and answers'],
    h3: ['Quick to set up', 'Secure by default', 'Works everywhere', 'Friendly support', 'Built to scale', 'Clear pricing', 'Thoughtful design', 'Always up to date'],
    p: [
      'A short paragraph that explains the idea in plain words and tells visitors why it matters to them.',
      'Describe the benefit in one or two sentences. Keep it concrete: what changes for the reader?',
      'Use this space for a quick story, a promise or a detail that builds trust.',
      'Replace this text with your own. Short sentences read best on every screen.',
    ],
    label: ['New', 'Popular', 'Product', 'Company', 'Support', 'Features', 'Pricing', 'Blog', 'About', 'Careers', 'Contact', 'Help'],
    btn: ['Get started', 'Start free', 'Book a demo', 'Sign up', 'Contact us', 'Subscribe'],
    link: ['Learn more', 'Features', 'Pricing', 'About', 'Blog', 'Contact', 'Careers', 'Help centre', 'Privacy', 'Terms'],
  },
  ru: {
    h1: ['Создайте то, что полюбят', 'Ваша работа — в лучшем виде', 'Растите быстрее и проще', 'Всё, что нужно команде', 'Для тех, кто создаёт'],
    h2: ['Почему выбирают нас', 'Возможности, которые важны', 'Что говорят клиенты', 'Простые и честные цены', 'Свяжитесь с нами', 'Свежие истории', 'Наша команда', 'Цифры, которыми гордимся', 'Как это работает', 'Вопросы и ответы'],
    h3: ['Быстрый старт', 'Безопасно по умолчанию', 'Работает везде', 'Дружелюбная поддержка', 'Растёт вместе с вами', 'Понятные цены', 'Продуманный дизайн', 'Всегда актуально'],
    p: [
      'Короткий абзац, который простыми словами объясняет идею и почему она важна посетителю.',
      'Опишите пользу в одном-двух предложениях. Конкретно: что изменится для читателя?',
      'Здесь может быть короткая история, обещание или деталь, которая вызывает доверие.',
      'Замените этот текст своим. Короткие предложения лучше читаются на любом экране.',
    ],
    label: ['Новинка', 'Популярное', 'Продукт', 'Компания', 'Поддержка', 'Возможности', 'Цены', 'Блог', 'О нас', 'Вакансии', 'Контакты', 'Помощь'],
    btn: ['Начать', 'Попробовать бесплатно', 'Записаться на демо', 'Зарегистрироваться', 'Связаться', 'Подписаться'],
    link: ['Подробнее', 'Возможности', 'Цены', 'О нас', 'Блог', 'Контакты', 'Вакансии', 'Центр помощи', 'Конфиденциальность', 'Условия'],
  },
};

/** Copy that fits the kind of section better than the general lists (product names, people, quotes). */
const BY_CATEGORY: Record<string, Partial<Record<'en' | 'ru', Partial<Record<Role, string[]>>>>> = {
  shop: {
    en: { h2: ['Canvas tote bag', 'Ceramic mug', 'Linen shirt', 'Leather notebook', 'Wool scarf', 'Desk lamp', 'Running shoes', 'Travel backpack'], h3: ['Canvas tote bag', 'Ceramic mug', 'Linen shirt', 'Leather notebook', 'Wool scarf', 'Desk lamp', 'Running shoes', 'Travel backpack'], label: ['New arrival', 'Bestseller', 'Accessories', 'Home', 'Clothing', 'Sale', 'In stock', 'Limited'], btn: ['Add to cart', 'Buy now', 'Shop the collection', 'View product'] },
    ru: { h2: ['Холщовая сумка', 'Керамическая кружка', 'Льняная рубашка', 'Кожаный блокнот', 'Шерстяной шарф', 'Настольная лампа', 'Беговые кроссовки', 'Дорожный рюкзак'], h3: ['Холщовая сумка', 'Керамическая кружка', 'Льняная рубашка', 'Кожаный блокнот', 'Шерстяной шарф', 'Настольная лампа', 'Беговые кроссовки', 'Дорожный рюкзак'], label: ['Новинка', 'Хит продаж', 'Аксессуары', 'Для дома', 'Одежда', 'Скидка', 'В наличии', 'Лимитированная серия'], btn: ['В корзину', 'Купить', 'Смотреть коллекцию', 'Подробнее'] },
  },
  team: {
    en: { h2: ['Anna Petrova', 'Mark Chen', 'Lena Novak', 'David Ruiz', 'Sara Kim', 'Ivan Sokolov'], h3: ['Anna Petrova', 'Mark Chen', 'Lena Novak', 'David Ruiz', 'Sara Kim', 'Ivan Sokolov'], label: ['Founder', 'Designer', 'Engineer', 'Product lead', 'Marketing', 'Support'] },
    ru: { h2: ['Анна Петрова', 'Марк Чен', 'Елена Новак', 'Давид Руис', 'Сара Ким', 'Иван Соколов'], h3: ['Анна Петрова', 'Марк Чен', 'Елена Новак', 'Давид Руис', 'Сара Ким', 'Иван Соколов'], label: ['Основатель', 'Дизайнер', 'Инженер', 'Руководитель продукта', 'Маркетинг', 'Поддержка'] },
  },
  proof: {
    en: { p: ['“We rebuilt our site in a week and doubled sign-ups.”', '“The easiest tool our team has adopted this year.”', '“Support answered in minutes, not days.”'], label: ['Anna Petrova', 'Mark Chen', 'Head of Marketing', 'Founder'] },
    ru: { p: ['«Пересобрали сайт за неделю и удвоили число заявок».', '«Самый простой инструмент, который мы внедрили в этом году».', '«Поддержка отвечает за минуты, а не за дни».'], label: ['Анна Петрова', 'Марк Чен', 'Директор по маркетингу', 'Основатель'] },
  },
};

const CATEGORY_RU: Record<string, string> = {
  Blog: 'Блог', Contact: 'Контакты', Content: 'Контент', 'Call to action': 'Призыв', Product: 'Товар', Features: 'Преимущества', Footer: 'Подвал', Gallery: 'Галерея', Header: 'Шапка', Hero: 'Первый экран', Pricing: 'Тарифы', Stats: 'Цифры', Steps: 'Шаги', Team: 'Команда', Testimonials: 'Отзывы', Banner: 'Баннер', 'Blog cards': 'Карточки блога', Cards: 'Карточки', 'Contact form': 'Форма связи', FAQ: 'Вопросы', 'Feature grid': 'Сетка преимуществ', 'Logo cloud': 'Логотипы', Newsletter: 'Рассылка', 'Product card': 'Карточка товара', 'Product collection': 'Подборка товаров', Section: 'Секция',
};

/** Fills the placeholders of one tree with copy in `locale`, rotating through each role's list. */
function fill(node: BlockNode, locale: string, seed: number, category: string): BlockNode {
  const lang = locale.toLowerCase().startsWith('ru') ? 'ru' : 'en';
  const used: Partial<Record<Role, number>> = {};
  const next = (role: Role) => {
    const list = BY_CATEGORY[category]?.[lang]?.[role] ?? COPY[lang][role];
    const i = (used[role] = (used[role] ?? seed) + 1);
    return list[i % list.length]!;
  };
  const sub = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\[\[(h1|h2|h3|p|label|btn|link)\]\]/g, (_, r: Role) => next(r));
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  const walk = (n: BlockNode): BlockNode => ({ ...n, props: sub(n.props) as Record<string, unknown>, children: n.children.map(walk) });
  return walk(node);
}

let cache: Promise<VendorPreset[]> | null = null;

/** All converted sections, loaded once. */
export function loadVendorSections(): Promise<VendorPreset[]> {
  cache ??= import('./sections-data').then(({ VENDOR_SECTIONS }) =>
    VENDOR_SECTIONS.map((v, i) => {
      const [cat, rest] = v.name.split(' · ');
      return {
        key: v.key,
        category: v.category,
        name: v.name,
        nameRu: `${CATEGORY_RU[cat!] ?? cat} · ${(rest ?? '').replace('(dark)', '(тёмный)')}`,
        source: { name: v.source, url: SOURCE_URL[v.source], license: 'MIT', file: v.file },
        build: (locale: string) => cloneWithIds(fill(v.tree, locale, i, v.category)),
      };
    }),
  );
  return cache;
}
