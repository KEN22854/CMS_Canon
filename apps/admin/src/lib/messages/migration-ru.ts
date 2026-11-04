import type { MigrationMessageKey } from './migration-en';

/** Центр миграции (этап 17). */
export const migrationRu: Record<MigrationMessageKey, string> = {
  'site.migration': 'Импорт',
  'mig.title': 'Перенос сайта в Canon',
  'mig.intro': 'Перенесите контент из WordPress: записи станут блогом со своими страницами, страницы сохранят вложенность, а все старые адреса будут перенаправлять на новые — позиции в поиске и ссылки сохранятся.',
  'mig.wordpress': 'WordPress',
  'mig.wpHow': 'В WordPress: Инструменты → Экспорт → Всё содержимое → Скачать файл экспорта. Затем выберите этот .xml-файл здесь.',
  'mig.choose': 'Выбрать файл экспорта',
  'mig.checking': 'Читаем экспорт…',
  'mig.report': 'Что будет импортировано из «{title}»',
  'mig.posts': 'Записи: {total} (опубликовано {published}, черновиков {drafts})',
  'mig.pages': 'Страницы: {total} (опубликовано {published}, черновиков {drafts})',
  'mig.categories': 'Рубрики: {list}',
  'mig.authors': 'Авторы: {list}',
  'mig.redirects': 'Перенаправлений со старых адресов (301): {count}',
  'mig.skipped': 'Не импортируется: {list}',
  'mig.import': 'Импортировать',
  'mig.importing': 'Импортируем… для больших сайтов это займёт минуту',
  'mig.done': 'Импортировано: записей {entries}, страниц {pages}, перенаправлений {redirects}',
  'mig.openBlog': 'Открыть записи',
  'mig.openPages': 'Открыть страницы',
  'mig.errors': 'Часть элементов не удалось импортировать',
  'mig.other': 'Другие платформы',
  'mig.otherHint': 'Экспорт из Tilda, Webflow и Wix и CSV для любых таблиц — следующими; CSV и JSON уже импортируются в любую коллекцию (Коллекции → Импорт).',
  'mig.again': 'Импортировать другой файл',
};
