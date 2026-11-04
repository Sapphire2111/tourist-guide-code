// Строка ассистента — «пилюля» как в поисковых строках мобильных приложений: значок слева, поле, справа круглая
// кнопка акцентного цвета — микрофон (пустое поле) или «надіслати» (есть текст). Голос: запись → POST
// /assistant/transcribe → текст и отправка. Один компонент для начального запроса (главная, пустой экран
// ассистента) и уточнений под ответом (variant="refine") — разный только текст.
import { useEffect, useState, type FormEvent } from "react";
import type { MessageKey } from "@tg/i18n";
import { useT } from "@tg/ui";
import { useErrorText } from "../host/errors.js";
import { TEXT_MAX, type AssistantApi } from "./assistant-api.js";
import { useRecorder } from "./recorder.js";
import "./assistant.css";

/** Подсказки-примеры под строкой на главной (текст чипа — сам запрос). */
export const HOME_EXAMPLES = ["weekend", "kids", "coffee", "chany"] as const;
/** Чередование плейсхолдера начальной строки, мс. */
const PLACEHOLDER_MS = 4000;
const START_PLACEHOLDERS = ["placeholder", "placeholderWish", "placeholderPlan"] as const;

export function AssistantBox({
  api,
  onSubmit,
  busy = false,
  id = "assistant-q",
  autoFocus = false,
  variant = "start",
  examples = false,
}: {
  api: AssistantApi;
  onSubmit: (text: string) => void;
  /** Ответ ещё не пришёл — новая реплика не отправляется. */
  busy?: boolean;
  id?: string;
  autoFocus?: boolean;
  /** start — «Що шукаєте?»; refine — уточнение под ответом («Скажіть, що додати або змінити»). */
  variant?: "start" | "refine";
  /** Чипы-примеры запросов под строкой (главная). */
  examples?: boolean;
}) {
  const { t } = useT();
  const errorText = useErrorText();
  const [draft, setDraft] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const refine = variant === "refine";

  const send = (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setDraft("");
    setStatus(null);
    onSubmit(q.slice(0, TEXT_MAX));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send(draft);
  };

  const recorder = useRecorder(
    (audio) => {
      setTranscribing(true);
      setStatus(t("miniapp.assistant.transcribing"));
      api.transcribe(audio).then(
        (text) => {
          setTranscribing(false);
          if (text) send(text);
          else setStatus(t("miniapp.assistant.noSpeech"));
        },
        (err: unknown) => {
          setTranscribing(false);
          setStatus(errorText(err, "miniapp.assistant.noSpeech"));
        },
      );
    },
    (reason) =>
      setStatus(reason === "denied" ? t("miniapp.assistant.micDenied") : t("miniapp.assistant.noSpeech")),
  );
  const recording = recorder.state === "recording";
  const micBlocked = busy || transcribing || recorder.state === "starting";
  const seconds = useSeconds(recording);
  const placeholderKey = useRotating(refine || recording ? null : START_PLACEHOLDERS);

  const placeholder = recording
    ? t("miniapp.assistant.listening", { s: formatSeconds(seconds) })
    : transcribing
      ? t("miniapp.assistant.transcribing")
      : refine
        ? t("miniapp.assistant.refine.placeholder")
        : t(`miniapp.assistant.${placeholderKey ?? "placeholder"}` as MessageKey);
  // Есть текст (или голос недоступен) — круглая кнопка отправляет; иначе — микрофон.
  const typing = draft.trim().length > 0 || !recorder.supported;
  const micLabel = t("miniapp.assistant.mic");

  return (
    <form
      role="search"
      onSubmit={submit}
      className="assistant"
      data-variant={variant}
      data-testid="assistant-box"
    >
      <div className="assistant-pill" data-recording={recording || undefined}>
        <label htmlFor={id} className="kosiv-sr-only">
          {refine ? t("miniapp.assistant.refine.label") : t("miniapp.assistant.label")}
        </label>
        <span className="assistant-pill-icon" aria-hidden="true">
          {refine ? "✦" : "🎙️"}
        </span>
        <input
          id={id}
          type="search"
          enterKeyHint="send"
          autoComplete="off"
          value={draft}
          maxLength={TEXT_MAX}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          disabled={recording || transcribing}
        />
        {typing ? (
          <button
            type="submit"
            className="assistant-action"
            data-testid="assistant-send"
            aria-label={t("miniapp.assistant.send")}
            disabled={busy || recording || transcribing || !draft.trim()}
          >
            <SendIcon />
          </button>
        ) : (
          // Подпись постоянная (имя кнопки не меняется во время записи — фокус и озвучка не сбиваются); запись —
          // aria-pressed, волны и таймер в поле. Не disabled во время ожидания: фокус остаётся на кнопке.
          <button
            type="button"
            className="assistant-action"
            data-testid="assistant-mic"
            aria-label={micLabel}
            aria-pressed={recording}
            aria-disabled={micBlocked}
            onClick={() => {
              if (micBlocked) return;
              setStatus(null);
              if (recording) recorder.stop();
              else recorder.start();
            }}
          >
            {/* Волны расходятся от кнопки микрофона (декор; нет в состоянии «надіслати»). */}
            <span className="mic-waves" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {recording ? (
              <StopIcon />
            ) : refine ? (
              <MicIcon />
            ) : (
              <span className="fire-flame" aria-hidden="true">
                🔥
              </span>
            )}
          </button>
        )}
      </div>
      {/* Постоянная live-область: запись, распознавание и ошибки голоса объявляются читалкой. */}
      <p role="status" className="kosiv-muted assistant-status" data-testid="assistant-voice-status">
        {recording ? t("miniapp.assistant.recording") : (status ?? "")}
      </p>
      {examples && (
        <div
          className="assistant-examples"
          role="group"
          aria-label={t("miniapp.assistant.examples")}
          data-testid="assistant-examples"
        >
          {HOME_EXAMPLES.map((e) => {
            const text = t(`miniapp.assistant.example.${e}` as MessageKey);
            return (
              <button key={e} type="button" className="kosiv-tag" disabled={busy} onClick={() => send(text)}>
                {text}
              </button>
            );
          })}
        </div>
      )}
    </form>
  );
}

/** Секунды записи (таймер в поле). */
function useSeconds(running: boolean): number {
  const [s, setS] = useState(0);
  useEffect(() => {
    setS(0);
    if (!running) return;
    const started = Date.now();
    const id = window.setInterval(() => setS(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  return s;
}

const formatSeconds = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Чередование подсказок; null — не чередовать. Уважает «уменьшить движение». */
function useRotating<T extends string>(list: readonly T[] | null): T | null {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!list || list.length < 2) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setI((x) => (x + 1) % list.length), PLACEHOLDER_MS);
    return () => window.clearInterval(id);
  }, [list]);
  return list ? (list[i % list.length] ?? null) : null;
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"
      />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M12 4l-7 7 1.41 1.41L11 7.83V20h2V7.83l4.59 4.58L19 11z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}
