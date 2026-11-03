// Сбой загрузки ленивого чанка после деплоя: старого хэша на сервере уже нет (Render отдаёт index.html),
// повтор import() не поможет — нужна перезагрузка страницы за свежим index.html.
// Те же тексты ошибки бывают при обрыве сети — тогда перезагрузка только хуже (пустая страница), её не делаем.
const RELOAD_KEY = "tg.chunkReloadAt";
/** Автоперезагрузка не чаще раза в это окно, мс (защита от цикла, если чанка нет и после обновления). */
const RELOAD_WINDOW_MS = 60_000;

const CHUNK_ERROR =
  /ChunkLoadError|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

/** Ошибка именно загрузки чанка (а не падения кода экрана). */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { name?: unknown; message?: unknown };
  return CHUNK_ERROR.test(`${String(e.name ?? "")} ${String(e.message ?? error)}`);
}

/** Устройство точно без сети (null/true — считаем, что сеть есть). */
function offline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Чанк потерян из-за деплоя (а не сети)? Адрес берём из текста ошибки (Chrome/Firefox); запрос вернул HTML или
 * не-2xx — файла уже нет. Запрос упал — сеть, не деплой. Адреса нет (Safari) — считаем деплоем, если онлайн.
 */
export async function chunkLostByDeploy(error: unknown): Promise<boolean> {
  if (offline()) return false;
  const text = String((error as { message?: unknown } | null)?.message ?? "");
  const url = /https?:\/\/[^\s"')]+/.exec(text)?.[0];
  if (!url) return true;
  try {
    const res = await fetch(url, { cache: "no-store" });
    return !res.ok || (res.headers.get("content-type") ?? "").includes("text/html");
  } catch {
    return false;
  }
}

/**
 * Перезагрузить страницу, если автоперезагрузка в этом сеансе ещё не была недавно и это деплой, а не сеть.
 * sessionStorage может быть недоступен — тогда не перезагружаем автоматически (иначе возможен цикл).
 * true — перезагрузка запущена.
 */
export async function reloadOnceForChunkError(error?: unknown, now = Date.now()): Promise<boolean> {
  if (offline()) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY));
    if (last && now - last < RELOAD_WINDOW_MS) return false;
  } catch {
    return false;
  }
  if (error !== undefined && !(await chunkLostByDeploy(error))) return false;
  try {
    sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  location.reload();
  return true;
}

/** Кнопка «Спробувати ще раз»: ошибка чанка при наличии сети — перезагрузка; офлайн — обычный повтор import(). */
export function reloadForChunkError(error: unknown): boolean {
  if (!isChunkLoadError(error) || offline()) return false;
  location.reload();
  return true;
}
