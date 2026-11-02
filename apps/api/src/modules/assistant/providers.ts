// Внешние сервисы ассистента: Claude (разбор запроса) и Google Speech-to-Text (речь → текст). Ключи — только на
// сервере; текст и аудио туриста не логируются (в логах — только статус ответа и код ошибки).
import Anthropic from "@anthropic-ai/sdk";
import { Logger } from "@nestjs/common";

export const ASSISTANT_CONFIG = Symbol("ASSISTANT_CONFIG");
export const ASSISTANT_LLM = Symbol("ASSISTANT_LLM");
export const ASSISTANT_SPEECH = Symbol("ASSISTANT_SPEECH");

export type AssistantConfig = {
  /** Ключ Claude API; нет — разбор запроса недоступен (503). */
  anthropicApiKey?: string | undefined;
  /** Серверный ключ Google с включённым Speech-to-Text; нет — голос недоступен (503). */
  googleApiKey?: string | undefined;
  /** Обращений к Claude и Speech-to-Text в сутки (UTC) на процесс. */
  dailyLimit?: number;
};

/** Сбой внешнего сервиса: reason — для конверта ошибки, без текста туриста. */
export class AssistantUpstreamError extends Error {
  constructor(
    readonly reason: "timeout" | "upstream" | "rejected",
    readonly status?: number,
  ) {
    super(`assistant upstream: ${reason}${status ? ` ${status}` : ""}`);
  }
}

/** Порт модели: создать сообщение (подменяется в тестах). */
export type AssistantLlm = {
  readonly enabled: boolean;
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
};

const LLM_TIMEOUT_MS = 20_000;

export function createAnthropicLlm(apiKey: string | undefined): AssistantLlm {
  // Ключ передаётся явно: без ANTHROPIC_API_KEY SDK не должен подхватывать чужие учётные данные окружения.
  const client = apiKey ? new Anthropic({ apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 1 }) : null;
  const log = new Logger("AssistantLlm");
  return {
    enabled: client !== null,
    async create(params) {
      if (!client) throw new AssistantUpstreamError("rejected");
      try {
        return await client.messages.create(params);
      } catch (e) {
        if (e instanceof Anthropic.APIConnectionTimeoutError) throw new AssistantUpstreamError("timeout");
        if (e instanceof Anthropic.APIError) {
          // Только статус: тело ошибки может содержать фрагменты запроса.
          log.warn(`Claude API: ${e.status ?? "network"}`);
          throw new AssistantUpstreamError("upstream", e.status ?? undefined);
        }
        throw e;
      }
    },
  };
}

/** Порт распознавания речи (подменяется в тестах). */
export type AssistantSpeech = {
  readonly enabled: boolean;
  /** Текст или "" — речь не распознана. */
  recognize(audio: Buffer, mime: AudioMime): Promise<string>;
};

/** Форматы MediaRecorder, которые понимает Speech-to-Text v1 (Opus в WebM/Ogg). */
export const AUDIO_MIMES = ["audio/webm", "audio/ogg"] as const;
export type AudioMime = (typeof AUDIO_MIMES)[number];

const SPEECH_URL = "https://speech.googleapis.com/v1/speech:recognize";
const SPEECH_TIMEOUT_MS = 15_000;

type RecognizeResponse = { results?: { alternatives?: { transcript?: string }[] }[] };

/** Google Speech-to-Text v1 speech:recognize (синхронно, до 1 мин аудио), язык uk-UA. */
export function createGoogleSpeech(
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): AssistantSpeech {
  const log = new Logger("AssistantSpeech");
  return {
    enabled: Boolean(apiKey),
    async recognize(audio, mime) {
      if (!apiKey) throw new AssistantUpstreamError("rejected");
      let res: Response;
      try {
        res = await fetchImpl(SPEECH_URL, {
          method: "POST",
          // Ключ — в заголовке, а не в адресе: адреса попадают в логи прокси.
          headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
          body: JSON.stringify({
            config: {
              encoding: mime === "audio/ogg" ? "OGG_OPUS" : "WEBM_OPUS",
              // Opus в браузерах — 48 кГц.
              sampleRateHertz: 48_000,
              languageCode: "uk-UA",
              enableAutomaticPunctuation: true,
              maxAlternatives: 1,
            },
            audio: { content: audio.toString("base64") },
          }),
          signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS),
        });
      } catch (e) {
        throw new AssistantUpstreamError((e as Error).name === "TimeoutError" ? "timeout" : "upstream");
      }
      if (!res.ok) {
        log.warn(`Speech-to-Text: ${res.status}`);
        throw new AssistantUpstreamError(res.status === 400 ? "rejected" : "upstream", res.status);
      }
      const body = (await res.json()) as RecognizeResponse;
      return (body.results ?? [])
        .map((r) => r.alternatives?.[0]?.transcript?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
    },
  };
}
