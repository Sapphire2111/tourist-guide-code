// Сохранённый диалог ассистента (sessionStorage вкладки): переживает переход в карточку места и «Назад».
import type { Async } from "../guide/context.js";
import type { AssistantResult } from "./assistant-api.js";

export type Turn = { id: number; text: string; state: Async<AssistantResult> };

/**
 * Диалог переживает переход в карточку места и «Назад» (без повторного платного запроса): сохраняются только
 * завершённые реплики — текст запроса и ответ каталога — в sessionStorage вкладки; «Новий пошук» и запрос на
 * удаление данных очищают. Запись с версией и id диалога: чужая форма не читается, поздний ответ прежнего экрана не
 * попадает в новый диалог.
 */
export const DIALOG_KEY = "tg.assistant.dialog.v1";

type StoredDialog = { v: 1; id: string; turns: { text: string; data: AssistantResult }[] };

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

/** Сохранённый диалог: id и завершённые реплики; нет или битый — новый. */
export function loadDialog(): { id: string; turns: Turn[] } | null {
  const d = readStored();
  return d
    ? {
        id: d.id,
        turns: d.turns.map((x, i) => ({ id: i + 1, text: x.text, state: { status: "ready", data: x.data } })),
      }
    : null;
}

export function saveDialog(id: string, turns: readonly Turn[]): void {
  try {
    const done = turns.flatMap((x) =>
      x.state.status === "ready" ? [{ text: x.text, data: x.state.data }] : [],
    );
    if (done.length) sessionStorage.setItem(DIALOG_KEY, JSON.stringify({ v: 1, id, turns: done }));
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
}

export const newDialogId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
