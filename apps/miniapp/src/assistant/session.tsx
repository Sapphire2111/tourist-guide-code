// Состояние ассистента выше маршрутов: диалог (реплики, ответы, намерение для уточнений) и состояние экрана ответа
// (раскрытые места, день плана, прокрутка) живут в провайдере, а не в экране, который размонтируется при переходе
// в карточку места. Дублируется в sessionStorage (dialog-store) — переживает и перезагрузку вкладки. Запрос, начатый
// на экране, дописывается в диалог и после ухода с экрана; новый диалог (запрос с главной, «Новий пошук») — сброс.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AssistantApi, AssistantAsk } from "./assistant-api.js";
import {
  clearAssistantDialog,
  DIALOG_CLEARED,
  loadDialog,
  newDialogId,
  saveDialog,
  type DialogUi,
  type Turn,
} from "./dialog-store.js";

export type AssistantSession = {
  id: string;
  turns: Turn[];
  /** Состояние экрана последнего ответа; null — с начала. */
  ui: DialogUi | null;
};

export type AssistantSessionApi = {
  session: AssistantSession;
  /** Реплика диалога; previous — намерение прошлого ответа (с ответами на уточнения). */
  ask(api: AssistantApi, req: Omit<AssistantAsk, "history">): void;
  /** Новый диалог (запрос с главной, «Новий пошук»): реплики и состояние экрана — с нуля, хранилище очищается. */
  reset(): void;
  /** Состояние экрана последнего ответа (shown, dayIndex, scrollY). */
  setUi(patch: Partial<Omit<DialogUi, "turn">>): void;
};

const Ctx = createContext<AssistantSessionApi | null>(null);

function initial(): AssistantSession {
  const d = loadDialog();
  return d ? { id: d.id, turns: d.turns, ui: d.ui } : { id: newDialogId(), turns: [], ui: null };
}

export function AssistantSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AssistantSession>(initial);
  // Актуальное значение для колбэков (поздние ответы, прокрутка) без пересоздания.
  const current = useRef(session);
  current.current = session;
  const nextId = useRef(Math.max(0, ...session.turns.map((t) => t.id)) + 1);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = useCallback((fn: (s: AssistantSession) => AssistantSession) => {
    setSession((s) => {
      const next = fn(s);
      current.current = next;
      saveDialog(next.id, next.turns, next.ui);
      return next;
    });
  }, []);

  const ask = useCallback<AssistantSessionApi["ask"]>(
    (api, req) => {
      const id = nextId.current++;
      const s = current.current;
      const dialog = s.id;
      const history = s.turns.map((x) => x.text);
      update((x) => ({
        ...x,
        turns: [...x.turns, { id, text: req.text, state: { status: "loading" } }],
        ui: null,
      }));
      api
        .ask({ ...req, history })
        .then(
          (data) => ({ status: "ready", data }) as const,
          (error: unknown) => ({ status: "error", error }) as const,
        )
        .then((state) => {
          // Провайдер уже снят (экран без провайдера выше маршрутов) — ответ дописывается только в хранилище своего
          // диалога: вернёмся — не платим повторно; уже начат новый диалог — не дописывается.
          if (!mounted.current) {
            const stored = loadDialog();
            const mine = stored?.id === dialog ? stored.turns : stored ? null : [];
            if (state.status === "ready" && mine)
              saveDialog(dialog, [...mine, { id, text: req.text, state }]);
            return;
          }
          // Только в свой диалог: если уже начат новый (другой id), поздний ответ не дописывается.
          update((x) =>
            x.id === dialog ? { ...x, turns: x.turns.map((t) => (t.id === id ? { ...t, state } : t)) } : x,
          );
        });
    },
    [update],
  );

  const forget = useCallback(() => {
    const next = { id: newDialogId(), turns: [], ui: null };
    current.current = next;
    setSession(next);
  }, []);
  const reset = useCallback(() => {
    clearAssistantDialog();
    forget();
  }, [forget]);
  // Удаление данных профиля очищает хранилище — и диалог в памяти.
  useEffect(() => {
    window.addEventListener(DIALOG_CLEARED, forget);
    return () => window.removeEventListener(DIALOG_CLEARED, forget);
  }, [forget]);

  const setUi = useCallback<AssistantSessionApi["setUi"]>(
    (patch) => {
      const last = current.current.turns[current.current.turns.length - 1];
      if (!last) return;
      update((x) => {
        const base: DialogUi =
          x.ui?.turn === last.id ? x.ui : { turn: last.id, shown: 0, dayIndex: 0, scrollY: 0 };
        const ui = { ...base, ...patch };
        return ui.shown === base.shown &&
          ui.dayIndex === base.dayIndex &&
          ui.scrollY === base.scrollY &&
          x.ui === base
          ? x
          : { ...x, ui };
      });
    },
    [update],
  );

  const value = useMemo(() => ({ session, ask, reset, setUi }), [session, ask, reset, setUi]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Провайдер выше маршрутов; вне его (тесты экрана) — null, экран оборачивает себя сам. */
export function useOptionalAssistantSession(): AssistantSessionApi | null {
  return useContext(Ctx);
}

export function useAssistantSession(): AssistantSessionApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("AssistantSessionProvider missing");
  return v;
}
