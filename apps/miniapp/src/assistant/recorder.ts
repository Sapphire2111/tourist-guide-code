// Запись голоса для ассистента: MediaRecorder (Opus в WebM/Ogg — их понимает Speech-to-Text). Нет MediaRecorder
// или он пишет только другой формат (iOS — audio/mp4) — голос недоступен, кнопка микрофона не показывается.
// Микрофон освобождается сразу после записи; запись не дольше RECORD_MAX_MS.
import { useCallback, useEffect, useRef, useState } from "react";

export const RECORD_MAX_MS = 15_000;
const MIMES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/ogg"];

type Env = {
  MediaRecorder?: { isTypeSupported?(t: string): boolean };
  navigator?: { mediaDevices?: { getUserMedia?: unknown } };
};

/** Формат записи, который примет сервер; undefined — голос недоступен. */
export function recordMime(env: Env = globalThis as Env): string | undefined {
  const MR = env.MediaRecorder;
  if (!MR?.isTypeSupported || typeof env.navigator?.mediaDevices?.getUserMedia !== "function")
    return undefined;
  return MIMES.find((m) => MR.isTypeSupported!(m));
}

export type RecorderState = "idle" | "starting" | "recording";

/**
 * start — запрос микрофона и запись; stop (или RECORD_MAX_MS) — onDone(blob). Отказ в доступе — onError("denied").
 * Микрофон освобождается всегда: после записи, при ошибке MediaRecorder и при уходе с экрана — в том числе если
 * разрешение пришло уже после размонтирования.
 */
export function useRecorder(
  onDone: (audio: Blob) => void,
  onError: (reason: "denied" | "failed") => void,
): { supported: boolean; state: RecorderState; start: () => void; stop: () => void } {
  const [mime] = useState(() => recordMime());
  const [state, setState] = useState<RecorderState>("idle");
  const rec = useRef<MediaRecorder | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const done = useRef(onDone);
  const fail = useRef(onError);
  useEffect(() => {
    done.current = onDone;
    fail.current = onError;
  });

  const stop = useCallback(() => {
    clearTimeout(timer.current);
    if (rec.current && rec.current.state !== "inactive") rec.current.stop();
  }, []);

  const start = useCallback(() => {
    if (!mime || busy.current) return;
    busy.current = true;
    setState("starting");
    const release = (stream: MediaStream) => stream.getTracks().forEach((t) => t.stop());
    navigator.mediaDevices.getUserMedia({ audio: true }).then(
      (stream) => {
        // Экран закрыт, пока ждали разрешения, — микрофон сразу освобождается.
        if (!alive.current) {
          release(stream);
          return;
        }
        const chunks: Blob[] = [];
        let r: MediaRecorder;
        try {
          r = new MediaRecorder(stream, { mimeType: mime });
          r.ondataavailable = (e) => {
            if (e.data.size) chunks.push(e.data);
          };
          r.onstop = () => {
            release(stream);
            rec.current = null;
            busy.current = false;
            if (!alive.current) return;
            setState("idle");
            const blob = new Blob(chunks, { type: mime });
            if (blob.size) done.current(blob);
            else fail.current("failed");
          };
          r.start();
        } catch {
          release(stream);
          rec.current = null;
          busy.current = false;
          setState("idle");
          fail.current("failed");
          return;
        }
        rec.current = r;
        setState("recording");
        timer.current = setTimeout(stop, RECORD_MAX_MS);
      },
      (e: unknown) => {
        busy.current = false;
        if (!alive.current) return;
        setState("idle");
        fail.current((e as { name?: string })?.name === "NotAllowedError" ? "denied" : "failed");
      },
    );
  }, [mime, stop]);

  // Уход с экрана посреди записи — запись прекращается без отправки, микрофон освобождается.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      const r = rec.current;
      if (r && r.state !== "inactive") r.stop();
    };
  }, []);

  return { supported: Boolean(mime), state, start, stop };
}
