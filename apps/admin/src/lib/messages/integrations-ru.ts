import type { IntegrationsMessageKey } from './integrations-en';

/** Локальные интеграции (этап 18). */
export const integrationsRu: Record<IntegrationsMessageKey, string> = {
  'tg.title': 'Telegram',
  'tg.desc': 'Получайте новые заказы и заявки с форм в чат Telegram и отправляйте сообщения из автоматизаций.',
  'tg.how': 'Создайте бота у @BotFather, добавьте его в чат или канал (в канале — администратором), затем вставьте токен и id чата.',
  'tg.token': 'Токен бота',
  'tg.tokenKeep': 'Сохранён ({hint}) — оставьте пустым, чтобы не менять',
  'tg.chat': 'Id чата или @канал',
  'tg.events': 'Присылать в чат',
  'tg.event.order.placed': 'Новые заказы',
  'tg.event.form.submitted': 'Заявки с форм',
  'tg.connect': 'Подключить',
  'tg.save': 'Сохранить',
  'tg.test': 'Отправить тестовое сообщение',
  'tg.tested': 'Тестовое сообщение отправлено',
  'tg.connected': 'Подключён бот @{bot} → {chat}',
  'tg.disconnect': 'Отключить',
  'tg.saved': 'Telegram подключён',
  'tg.disconnected': 'Telegram отключён',
  'auto.action.telegram': 'Сообщение в Telegram',
  'auto.tgText': 'Сообщение',
};
