/** Local integrations (Stage 18). */
export const integrationsEn = {
  'tg.title': 'Telegram',
  'tg.desc': 'Get new orders and form requests in a Telegram chat, and send messages from automations.',
  'tg.how': 'Create a bot with @BotFather, add it to your chat or channel (as an admin for channels), then paste the token and the chat id.',
  'tg.token': 'Bot token',
  'tg.tokenKeep': 'Saved ({hint}) — leave empty to keep it',
  'tg.chat': 'Chat id or @channel',
  'tg.events': 'Post to the chat',
  'tg.event.order.placed': 'New orders',
  'tg.event.form.submitted': 'Form requests',
  'tg.connect': 'Connect',
  'tg.save': 'Save',
  'tg.test': 'Send a test message',
  'tg.tested': 'Test message sent',
  'tg.connected': 'Connected as @{bot} → {chat}',
  'tg.disconnect': 'Disconnect',
  'tg.saved': 'Telegram connected',
  'tg.disconnected': 'Telegram disconnected',
  'auto.action.telegram': 'Message to Telegram',
  'auto.tgText': 'Message',
} as const;

export type IntegrationsMessageKey = keyof typeof integrationsEn;
