// Точка входа "@tg/i18n/en": синхронно регистрирует en-словарь (тесты, серверный код).
import { en } from "./en-messages.js";
import { registerLocale } from "./index.js";

registerLocale("en", en);

export { en };
