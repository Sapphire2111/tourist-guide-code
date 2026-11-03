// Сбой загрузки ленивого чанка после деплоя: старого хэша на сервере уже нет (Render отдаёт index.html),
// повтор import() не поможет — нужна перезагрузка страницы за свежим index.html.
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

/**
 * Перезагрузить страницу, если автоперезагрузка в этом сеансе ещё не была недавно. true — перезагрузка запущена.
 * sessionStorage может быть недоступен — тогда не перезагружаем автоматически (иначе возможен цикл).
 */
export function reloadOnceForChunkError(now = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY));
    if (last && now - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  location.reload();
  return true;
}

/** Кнопка «Спробувати ще раз»: для ошибки чанка — безусловная перезагрузка. true — перезагружаем. */
export function reloadForChunkError(error: unknown): boolean {
  if (!isChunkLoadError(error)) return false;
  location.reload();
  return true;
}
