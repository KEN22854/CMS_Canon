import type { FunnelMessageKey } from './funnel-en';

/** Воронки (этап 12). */
export const funnelRu: Record<FunnelMessageKey, string> = {
  'funnel.title': 'Воронки',
  'funnel.intro': 'Сколько посетителей проходят ваши шаги по порядку — и где они уходят.',
  'funnel.new': 'Новая воронка',
  'funnel.empty': 'Воронок пока нет. Например: страница товара → add_to_cart → /cart → purchase.',
  'funnel.name': 'Название',
  'funnel.window': 'Шаги должны пройти',
  'funnel.window.session': 'За один визит',
  'funnel.window.days': 'За {days} дн.',
  'funnel.step': 'Шаг {n}',
  'funnel.kind.page': 'Открыл страницу',
  'funnel.kind.event': 'Совершил событие',
  'funnel.path': 'Путь (/pricing, или /blog/* для раздела)',
  'funnel.event': 'Событие (cta_click, form_submit, purchase…)',
  'funnel.addStep': 'Добавить шаг',
  'funnel.removeStep': 'Убрать шаг {n}',
  'funnel.save': 'Сохранить воронку',
  'funnel.cancel': 'Отмена',
  'funnel.saved': 'Воронка сохранена',
  'funnel.delete': 'Удалить воронку «{name}»',
  'funnel.visitors': 'Посетителей: {count}',
  'funnel.ofFirst': '{pct} от первого шага',
  'funnel.drop': '−{pct} на этом шаге',
  'funnel.conversion': 'Конверсия {pct}',
};
