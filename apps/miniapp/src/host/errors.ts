// Текст ошибки для экранов блока 5: 401 — «войдите снова»; известный messageKey сервера — его перевод;
// иначе — запасной текст экрана.
import { uk, type MessageKey } from "@tg/i18n";
import { useT } from "@tg/ui";
import { UnauthorizedError } from "../guide/types.js";
import { ApiCallError } from "./types.js";

export function isMessageKey(key: string | null | undefined): key is MessageKey {
  return typeof key === "string" && Object.hasOwn(uk, key);
}

export function useErrorText(): (err: unknown, fallback: MessageKey) => string {
  const { t } = useT();
  return (err, fallback) => {
    if (err instanceof UnauthorizedError) return t("miniapp.auth.again");
    if (err instanceof ApiCallError && isMessageKey(err.messageKey)) return t(err.messageKey);
    return t(fallback);
  };
}
