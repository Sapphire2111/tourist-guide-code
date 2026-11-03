// Сохранённый диалог ассистента (sessionStorage вкладки): переживает переход в карточку места и «Назад».
import type { Async } from "../guide/context.js";
import type { AssistantResult } from "./assistant-api.js";

export type Turn = { id: number; text: string; state: Async<AssistantResult> };

/**
 * Состояние экрана ответа: сколько мест раскрыто («Показати ще»), выбранный день плана, прокрутка, выбор в
 * уточняющих вопросах. Восстанавливается вместе с диалогом после «Назад» из карточки места.
 */
export type DialogUi = {
  /** Ответ, к которому относится состояние (id реплики); другой ответ — состояние с начала. */
  turn: number;
  shown: number;
  dayIndex: number;
  scrollY: number;
};

/**
 * Диалог переживает переход в карточку места и «Назад» (без повторного платного запроса): сохраняются только
 * завершённые реплики — текст запроса и ответ каталога — и состояние экрана в sessionStorage вкладки; «Новий пошук»
 * и запрос на удаление данных очищают. Запись с версией и id диалога: чужая форма не читается, поздний ответ
 * прежнего экрана не попадает в новый диалог.
 */
export const DIALOG_KEY = "tg.assistant.dialog.v1";

type StoredDialog = { v: 1; id: string; turns: { text: string; data: AssistantResult }[]; ui?: DialogUi };

function isUi(x: unknown): x is DialogUi {
  const u = x as DialogUi | null;
  return (
    typeof u === "object" &&
    u !== null &&
    [u.turn, u.shown, u.dayIndex, u.scrollY].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
    )
  );
}

function isStoredDialog(x: unknown): x is StoredDialog {
  const d = x as StoredDialog | null;
  return (
    typeof d === "object" &&
    d !== null &&
    d.v === 1 &&
    typeof d.id === "string" &&
    Array.isArray(d.turns) &&
    d.turns.every(
      (t) =>
        typeof t?.text === "string" &&
        typeof t.data === "object" &&
        t.data !== null &&
        Array.isArray(t.data.items) &&
        typeof t.data.intent === "object" &&
        t.data.intent !== null,
    )
  );
}

function readStored(): StoredDialog | null {
  try {
    const raw = sessionStorage.getItem(DIALOG_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return isStoredDialog(v) ? v : null;
  } catch {
    return null;
  }
}

/** Сохранённый диалог: id, завершённые реплики и состояние экрана; нет или битый — null. */
export function loadDialog(): { id: string; turns: Turn[]; ui: DialogUi | null } | null {
  const d = readStored();
  return d
    ? {
        id: d.id,
        turns: d.turns.map((x, i) => ({ id: i + 1, text: x.text, state: { status: "ready", data: x.data } })),
        ui: isUi(d.ui) ? d.ui : null,
      }
    : null;
}

export function saveDialog(id: string, turns: readonly Turn[], ui: DialogUi | null = null): void {
  try {
    const done = turns.flatMap((x) =>
      x.state.status === "ready" ? [{ text: x.text, data: x.state.data }] : [],
    );
    // В хранилище реплики нумеруются заново (1…) — состояние экрана — к последней сохранённой.
    const stored = ui ? { ...ui, turn: done.length } : undefined;
    if (done.length)
      sessionStorage.setItem(
        DIALOG_KEY,
        JSON.stringify({ v: 1, id, turns: done, ...(stored ? { ui: stored } : {}) }),
      );
    else if (readStored()?.id === id) sessionStorage.removeItem(DIALOG_KEY);
  } catch {
    // хранилище недоступно — диалог живёт только на экране
  }
}

/** Удалить сохранённый диалог (запрос на удаление данных профиля). */
export function clearAssistantDialog(): void {
  try {
    sessionStorage.removeItem(DIALOG_KEY);
  } catch {
    // нет хранилища — нечего очищать
  }
  // Диалог в памяти (провайдер выше маршрутов) — тоже.
  window.dispatchEvent(new Event(DIALOG_CLEARED));
}

/** Событие окна: сохранённый диалог удалён (провайдер сбрасывает диалог в памяти). */
export const DIALOG_CLEARED = "tg-assistant-dialog-cleared";

export const newDialogId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
