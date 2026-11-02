export type PartnerModuleOptions = {
  /** TELEGRAM_BOT_TOKEN: уведомления о модерации ботом; без него — строки notifications со статусом skipped. */
  botToken?: string;
  /** TELEGRAM_BOT_USERNAME: готовая ссылка-приглашение t.me/<бот>?startapp=…; без него — только startParam. */
  botUsername?: string;
};

/** DI-токен настроек модуля партнёра. */
export const PARTNER_OPTIONS = Symbol("PARTNER_OPTIONS");
