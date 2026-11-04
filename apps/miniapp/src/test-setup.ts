// Каждый тест — как новый вход в приложение: учёт истории (back.ts) не тянется из предыдущего теста того же файла.
import { afterEach } from "vitest";
import { resetNavigation } from "./back.js";

afterEach(() => {
  resetNavigation();
});
