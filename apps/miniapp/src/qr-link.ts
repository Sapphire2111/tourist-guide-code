// Разбор текста, считанного сканером QR: наши QR — ссылки t.me/<бот>?startapp=<код> (или ?start=), tg://resolve.
// Чужие ссылки и произвольный текст не открываем — только сообщение «Це не QR-код Гіда туриста».
import { INVITE_PREFIX, INVITE_TOKEN_RE } from "./partner/partner-api.js";

/** Формат кода QR-точки — как QR_CODE_RE сервера (символы startapp, длина 10–64). */
export const QR_CODE_RE = /^[A-Za-z0-9_-]{10,64}$/;

export type QrScan = { kind: "code"; code: string } | { kind: "invite"; token: string } | { kind: "foreign" };

const FOREIGN: QrScan = { kind: "foreign" };
const HOSTS = new Set(["t.me", "telegram.me", "telegram.dog"]);

/** Имя нашего бота (если задано при сборке) — ссылки на других ботов отвергаются; иначе решает сервер по коду. */
const BOT: string = import.meta.env?.VITE_BOT_USERNAME?.replace(/^@/, "") ?? "";

function classify(param: string | null): QrScan {
  if (!param) return FOREIGN;
  if (param.startsWith(INVITE_PREFIX)) {
    const token = param.slice(INVITE_PREFIX.length);
    return INVITE_TOKEN_RE.test(token) ? { kind: "invite", token } : FOREIGN;
  }
  // Как checkStartParam сервера: допустимые символы/длина и не одни цифры.
  if (!QR_CODE_RE.test(param) || /^[0-9]+$/.test(param)) return FOREIGN;
  return { kind: "code", code: param };
}

export function parseQrText(raw: string, botUsername: string = BOT): QrScan {
  const text = raw.trim();
  if (text === "" || text.length > 512) return FOREIGN;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return FOREIGN;
  }
  let bot: string | undefined;
  if (url.protocol === "tg:" || url.protocol === "tg://") {
    if (url.hostname !== "resolve") return FOREIGN;
    bot = url.searchParams.get("domain") ?? undefined;
  } else if (url.protocol === "https:" || url.protocol === "http:") {
    if (!HOSTS.has(url.hostname.toLowerCase())) return FOREIGN;
    bot = url.pathname.split("/").filter(Boolean)[0];
  } else return FOREIGN;
  if (!bot || !/^[A-Za-z0-9_]{3,32}$/.test(bot)) return FOREIGN;
  if (botUsername && bot.toLowerCase() !== botUsername.toLowerCase()) return FOREIGN;
  return classify(url.searchParams.get("startapp") ?? url.searchParams.get("start"));
}
