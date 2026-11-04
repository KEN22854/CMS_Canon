/**
 * What a shop's visitors read — the cart, checkout and the order email — in the page's language
 * (Stage 15). One dictionary for the site's script and the API's emails. Unknown locales fall back
 * to English; a regional locale ("de-AT") uses its language.
 */
const en = {
  added: 'Added to cart',
  openCart: 'Open cart',
  remove: 'Remove',
  quantity: 'Quantity of {title}',
  total: 'Total',
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  address: 'Delivery address',
  note: 'Note for the shop',
  payment: 'Payment',
  cash: 'Cash on delivery',
  card_on_delivery: 'Card on delivery',
  transfer: 'Bank transfer',
  order: 'Order #{number}',
  sending: 'Placing the order…',
  OUT_OF_STOCK: 'Not enough in stock: {message}',
  PRODUCT_UNAVAILABLE: 'Some products are no longer available — remove them and try again.',
  RATE_LIMITED: 'Too many orders — try again in a few minutes.',
  error: 'The order could not be placed. Try again.',
  offline: 'Payment is made offline: the shop will contact you.',
  mailSubject: '{shop}: order #{number} received',
  mailTitle: 'Order #{number} received',
  mailThanks: 'Thank you! {shop} has your order.',
  mailNext: 'The shop will contact you about delivery.',
};
type ShopKey = keyof typeof en;

export const SHOP_STRINGS: Record<'en' | 'ru' | 'de' | 'fr' | 'es', Record<ShopKey, string>> = {
  en,
  ru: {
    added: 'Добавлено в корзину', openCart: 'Открыть корзину', remove: 'Убрать', quantity: 'Количество: {title}', total: 'Итого', name: 'Имя', email: 'Эл. почта', phone: 'Телефон', address: 'Адрес доставки', note: 'Комментарий для магазина', payment: 'Оплата', cash: 'Наличными при получении', card_on_delivery: 'Картой при получении', transfer: 'Банковский перевод', order: 'Заказ №{number}', sending: 'Оформляем заказ…', OUT_OF_STOCK: 'Не хватает на складе: {message}', PRODUCT_UNAVAILABLE: 'Некоторых товаров больше нет — уберите их и попробуйте снова.', RATE_LIMITED: 'Слишком много заказов — попробуйте через несколько минут.', error: 'Не получилось оформить заказ. Попробуйте ещё раз.', offline: 'Оплата не через сайт: магазин свяжется с вами.',
    mailSubject: '{shop}: заказ №{number} принят', mailTitle: 'Заказ №{number} принят', mailThanks: 'Спасибо! {shop} получил ваш заказ.', mailNext: 'Магазин свяжется с вами по поводу доставки.',
  },
  de: {
    added: 'In den Warenkorb gelegt', openCart: 'Warenkorb öffnen', remove: 'Entfernen', quantity: 'Menge von {title}', total: 'Summe', name: 'Name', email: 'E-Mail', phone: 'Telefon', address: 'Lieferadresse', note: 'Hinweis für den Shop', payment: 'Zahlung', cash: 'Barzahlung bei Lieferung', card_on_delivery: 'Kartenzahlung bei Lieferung', transfer: 'Banküberweisung', order: 'Bestellung Nr. {number}', sending: 'Bestellung wird aufgegeben…', OUT_OF_STOCK: 'Nicht genug auf Lager: {message}', PRODUCT_UNAVAILABLE: 'Einige Produkte sind nicht mehr verfügbar — bitte entfernen und erneut versuchen.', RATE_LIMITED: 'Zu viele Bestellungen — bitte in ein paar Minuten erneut versuchen.', error: 'Die Bestellung konnte nicht aufgegeben werden. Bitte erneut versuchen.', offline: 'Die Zahlung erfolgt nicht online: Der Shop meldet sich bei Ihnen.',
    mailSubject: '{shop}: Bestellung Nr. {number} eingegangen', mailTitle: 'Bestellung Nr. {number} eingegangen', mailThanks: 'Vielen Dank! {shop} hat Ihre Bestellung erhalten.', mailNext: 'Der Shop meldet sich wegen der Lieferung bei Ihnen.',
  },
  fr: {
    added: 'Ajouté au panier', openCart: 'Voir le panier', remove: 'Retirer', quantity: 'Quantité de {title}', total: 'Total', name: 'Nom', email: 'E-mail', phone: 'Téléphone', address: 'Adresse de livraison', note: 'Note pour la boutique', payment: 'Paiement', cash: 'Espèces à la livraison', card_on_delivery: 'Carte à la livraison', transfer: 'Virement bancaire', order: 'Commande n° {number}', sending: 'Envoi de la commande…', OUT_OF_STOCK: 'Stock insuffisant : {message}', PRODUCT_UNAVAILABLE: 'Certains produits ne sont plus disponibles — retirez-les et réessayez.', RATE_LIMITED: 'Trop de commandes — réessayez dans quelques minutes.', error: 'La commande n’a pas pu être passée. Réessayez.', offline: 'Le paiement se fait hors ligne : la boutique vous contactera.',
    mailSubject: '{shop} : commande n° {number} reçue', mailTitle: 'Commande n° {number} reçue', mailThanks: 'Merci ! {shop} a bien reçu votre commande.', mailNext: 'La boutique vous contactera pour la livraison.',
  },
  es: {
    added: 'Añadido al carrito', openCart: 'Ver carrito', remove: 'Quitar', quantity: 'Cantidad de {title}', total: 'Total', name: 'Nombre', email: 'Correo electrónico', phone: 'Teléfono', address: 'Dirección de entrega', note: 'Nota para la tienda', payment: 'Pago', cash: 'Efectivo a la entrega', card_on_delivery: 'Tarjeta a la entrega', transfer: 'Transferencia bancaria', order: 'Pedido n.º {number}', sending: 'Enviando el pedido…', OUT_OF_STOCK: 'No hay suficiente stock: {message}', PRODUCT_UNAVAILABLE: 'Algunos productos ya no están disponibles: quítalos e inténtalo de nuevo.', RATE_LIMITED: 'Demasiados pedidos: inténtalo de nuevo en unos minutos.', error: 'No se pudo realizar el pedido. Inténtalo de nuevo.', offline: 'El pago no se hace en línea: la tienda se pondrá en contacto contigo.',
    mailSubject: '{shop}: pedido n.º {number} recibido', mailTitle: 'Pedido n.º {number} recibido', mailThanks: '¡Gracias! {shop} ha recibido tu pedido.', mailNext: 'La tienda se pondrá en contacto contigo para la entrega.',
  },
};
export type ShopStringKey = ShopKey;

export function shopText(locale: string | undefined, key: ShopKey, vars: Record<string, string | number> = {}): string {
  const lang = (locale ?? 'en').slice(0, 2).toLowerCase() as keyof typeof SHOP_STRINGS;
  const dict = SHOP_STRINGS[lang] ?? SHOP_STRINGS.en;
  return (dict[key] ?? en[key]).replace(/\{(\w+)\}/g, (_, v: string) => String(vars[v] ?? ''));
}
