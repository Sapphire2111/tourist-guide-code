// Точка входа "@tg/i18n/admin": регистрирует строки admin.* в словарях (импорт ради побочного эффекта).
import { adminEn, adminUk } from "./admin-messages.js";
import { registerMessages } from "./index.js";

registerMessages({ uk: adminUk, en: adminEn });

export { adminEn, adminUk };
