// Поле «Що шукаєте?» с кнопкой микрофона: текст или голос (запись → POST /assistant/transcribe → текст в поле и
// отправка). На главной ведёт на экран ассистента, на экране ассистента — следующая реплика диалога.
import { useState, type FormEvent } from "react";
import { Button, useT } from "@tg/ui";
import { useErrorText } from "../host/errors.js";
import { TEXT_MAX, type AssistantApi } from "./assistant-api.js";
import { useRecorder } from "./recorder.js";
import "./assistant.css";

export function AssistantBox({
  api,
  onSubmit,
  busy = false,
  id = "assistant-q",
  autoFocus = false,
}: {
  api: AssistantApi;
  onSubmit: (text: string) => void;
  /** Ответ ещё не пришёл — новая реплика не отправляется. */
  busy?: boolean;
  id?: string;
  autoFocus?: boolean;
}) {
  const { t } = useT();
  const errorText = useErrorText();
  const [draft, setDraft] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

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

  return (
    <form role="search" onSubmit={submit} className="assistant" data-testid="assistant-box">
      <label htmlFor={id} className="assistant-label">
        {t("miniapp.assistant.label")}
      </label>
      <div className="assistant-row">
        <input
          id={id}
          type="search"
          enterKeyHint="search"
          value={draft}
          maxLength={TEXT_MAX}
          autoFocus={autoFocus}
          placeholder={t("miniapp.assistant.placeholder")}
          onChange={(e) => setDraft(e.target.value)}
          disabled={recording || transcribing}
        />
        <Button type="submit" disabled={busy || recording || transcribing || !draft.trim()}>
          {t("miniapp.assistant.send")}
        </Button>
      </div>
      {recorder.supported && (
        // Подпись постоянная (имя кнопки не меняется во время записи — фокус и озвучка не сбиваются); запись —
        // aria-pressed и строка статуса ниже. Не disabled во время ожидания: фокус остаётся на кнопке.
        <button
          type="button"
          className="assistant-mic"
          data-testid="assistant-mic"
          aria-pressed={recording}
          aria-disabled={micBlocked}
          onClick={() => {
            if (micBlocked) return;
            setStatus(null);
            if (recording) recorder.stop();
            else recorder.start();
          }}
        >
          {recording ? <StopIcon /> : <MicIcon />}
          <span>{t("miniapp.assistant.mic")}</span>
        </button>
      )}
      {/* Постоянная live-область: запись, распознавание и ошибки голоса объявляются читалкой. */}
      <p role="status" className="kosiv-muted assistant-status" data-testid="assistant-voice-status">
        {recording ? t("miniapp.assistant.recording") : (status ?? "")}
      </p>
    </form>
  );
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

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}
