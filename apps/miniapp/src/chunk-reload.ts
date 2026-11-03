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

/** Сколько ждать проверочный запрос, мс; таймаут — считаем сетевым сбоем, не деплоем. */
const CHECK_TIMEOUT_MS = 5_000;

type Checked = { ok: boolean; contentType: string; text: string };

/**
 * Проверочный запрос с общим таймаутом на ответ и чтение тела (`withBody`). AbortController — потому что
 * AbortSignal.timeout есть не во всех старых WebView; гонка с таймером — если abort не прервал fetch/чтение.
 * Сбой или таймаут — null.
 */
async function fetchChecked(url: string, withBody = false): Promise<Checked | null> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const run = async (): Promise<Checked> => {
    const res = await fetch(url, { cache: "no-store", signal: ctrl?.signal });
    return {
      ok: res.ok,
      contentType: res.headers.get("content-type") ?? "",
      text: withBody ? await res.text() : "",
    };
  };
  try {
    timers.push(setTimeout(() => ctrl?.abort(), CHECK_TIMEOUT_MS));
    return await Promise.race([
      run(),
      new Promise<null>((resolve) => {
        timers.push(setTimeout(() => resolve(null), CHECK_TIMEOUT_MS));
      }),
    ]);
  } catch {
    return null;
  } finally {
    timers.forEach(clearTimeout);
  }
}

/** Адрес входного модульного скрипта в HTML (хэш меняется с каждой сборкой). */
function entryScript(html: string): string | null {
  const m = /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/i.exec(html);
  return m ? new URL(m[1]!, location.href).pathname : null;
}

function currentEntry(): string | null {
  const el =
    typeof document !== "undefined"
      ? document.querySelector<HTMLScriptElement>("script[type=module][src]")
      : null;
  return el ? new URL(el.src, location.href).pathname : null;
}

/**
 * Чанк потерян из-за деплоя (а не сети)? Адрес берём из текста ошибки (Chrome/Firefox): запрос вернул HTML или
 * не-2xx — файла уже нет. Адреса нет (iOS) — смотрим index.html: другой хэш входного скрипта — деплой; тот же —
 * чанк недоступен по другой причине; сравнить нельзя — «сервер отвечает» считаем деплоем. Запрос упал или завис
 * (таймаут) — сеть, не деплой.
 */
export async function chunkLostByDeploy(error: unknown): Promise<boolean> {
  if (offline()) return false;
  const text = String((error as { message?: unknown } | null)?.message ?? "");
  const url = /https?:\/\/[^\s"')]+/.exec(text)?.[0];
  if (url) {
    const res = await fetchChecked(url);
    if (!res) return false;
    return !res.ok || res.contentType.includes("text/html");
  }
  const res = await fetchChecked(location.pathname || "/", true);
  if (!res || !res.ok) return false;
  // Входного скрипта в ответе нет (captive portal, чужая страница) — это не наш деплой.
  const latest = entryScript(res.text);
  if (!latest) return false;
  const mine = currentEntry();
  return mine ? latest !== mine : true;
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

/**
 * Кнопка «Спробувати ще раз»: ошибка чанка и это деплой — перезагрузка (true); иначе (сеть, не чанк) false —
 * вызывающий повторяет import().
 */
export async function reloadForChunkError(error: unknown): Promise<boolean> {
  if (!isChunkLoadError(error) || !(await chunkLostByDeploy(error))) return false;
  location.reload();
  return true;
}
