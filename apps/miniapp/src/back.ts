// «Назад» экрана (BackButton Telegram и своя кнопка): обратно по истории — только если экран открыт из ассистента
// (запись истории помечена при переходе), иначе — на главную заменой. Так replace-переходы (QR → «Про заклад»,
// приглашение) и вход прямо на #/assistant (одна запись истории) не выкидывают из Mini App.

/** Метка записи истории: экран открыт из ассистента — «Назад» возвращает в ассистент по истории. */
export const FROM_ASSISTANT = "tgFromAssistant";

type HistoryLike = Pick<History, "state" | "back" | "pushState">;

/** Переход из ассистента в экран приложения (ссылка #/…) — новая запись истории с меткой. */
export function pushFromAssistant(href: string, history: HistoryLike = window.history): void {
  history.pushState({ [FROM_ASSISTANT]: true }, "", href);
  // pushState не порождает hashchange — роутер узнаёт о переходе из события.
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/**
 * Повторное нажатие, пока возврат по истории не случился (адрес тот же), — не уводит на шаг дальше (из Mini App).
 * Возврат случился (адрес сменился) — следующее нажатие обычное.
 */
const GUARD_MS = 1000;
let backingUntil = 0;
let backingFrom: string | null = null;

export function goBack(
  navigate: (to: string, opts?: { replace?: boolean }) => void,
  history: HistoryLike = window.history,
  now: () => number = Date.now,
): void {
  if (now() < backingUntil && window.location.hash === backingFrom) return;
  const state = history.state as Record<string, unknown> | null;
  if (state?.[FROM_ASSISTANT] === true) {
    backingUntil = now() + GUARD_MS;
    backingFrom = window.location.hash;
    history.back();
    return;
  }
  navigate("/", { replace: true });
}

/** Для тестов: сброс защиты от двойного нажатия. */
export function resetBackGuard(): void {
  backingUntil = 0;
  backingFrom = null;
}
