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
  /** Единиц (запрос — 1, голос — 2) в сутки (UTC) на всё api — Claude и Speech-to-Text. */
  dailyLimit?: number;
  /** Единиц в сутки на пользователя. */
  userDailyLimit?: number;
};

/** Сбой внешнего сервиса: reason — для конверта ошибки, без текста туриста. */
export class AssistantUpstreamError extends Error {
  constructor(
    /** config — неверный ключ или выключенный API (503); rejected — плохое аудио (422). */
    readonly reason: "timeout" | "upstream" | "rejected" | "config",
    readonly status?: number,
  ) {
    super(`assistant upstream: ${reason}${status ? ` ${status}` : ""}`);
  }
}

/** Порт модели: создать сообщение (подменяется в тестах). */
export type AssistantLlm = {
  readonly enabled: boolean;
  /** timeoutMs — свой предел вызова (короче общего LLM_TIMEOUT_MS), напр. для пояснений к плану. */
  create(
    params: Anthropic.MessageCreateParamsNonStreaming,
    opts?: { timeoutMs?: number },
  ): Promise<Anthropic.Message>;
};

const LLM_TIMEOUT_MS = 20_000;

export function createAnthropicLlm(apiKey: string | undefined): AssistantLlm {
  // Ключ передаётся явно: без ANTHROPIC_API_KEY SDK не должен подхватывать чужие учётные данные окружения.
  // Без повторов SDK: каждый вызов учтён в суточном пределе как одна единица.
  const client = apiKey ? new Anthropic({ apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 0 }) : null;
  const log = new Logger("AssistantLlm");
  return {
    enabled: client !== null,
    async create(params, opts) {
      if (!client) throw new AssistantUpstreamError("config");
      try {
        return await client.messages.create(
          params,
          opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
        );
      } catch (e) {
        if (e instanceof Anthropic.APIConnectionTimeoutError) throw new AssistantUpstreamError("timeout");
        if (e instanceof Anthropic.APIError) {
          // Только статус: тело ошибки может содержать фрагменты запроса.
          log.warn(`Claude API: ${e.status ?? "network"}`);
          const config = e.status === 401 || e.status === 403;
          throw new AssistantUpstreamError(config ? "config" : "upstream", e.status ?? undefined);
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
type GoogleError = { error?: { status?: string; details?: { reason?: string }[] } };

/** Ошибки ключа и проекта Google: не вина аудио — ассистент недоступен (503). */
const CONFIG_REASONS = new Set([
  "API_KEY_INVALID",
  "API_KEY_SERVICE_BLOCKED",
  "API_KEY_HTTP_REFERRER_BLOCKED",
  "API_KEY_IP_ADDRESS_BLOCKED",
  "SERVICE_DISABLED",
  "BILLING_DISABLED",
]);

/** Причина отказа Speech-to-Text: config (ключ/API), rejected (запрос с аудио), upstream (прочее). */
export function speechFailure(
  status: number,
  body: unknown,
): { reason: AssistantUpstreamError["reason"]; code: string } {
  const err = (body as GoogleError | null)?.error;
  const reason = err?.details?.find((d) => typeof d?.reason === "string")?.reason;
  const code = [err?.status, reason].filter(Boolean).join("/") || "-";
  if (
    status === 401 ||
    status === 403 ||
    err?.status === "PERMISSION_DENIED" ||
    err?.status === "UNAUTHENTICATED" ||
    (reason !== undefined && CONFIG_REASONS.has(reason))
  )
    return { reason: "config", code };
  if (status === 400) return { reason: "rejected", code };
  return { reason: "upstream", code };
}

/** Google Speech-to-Text v1 speech:recognize (синхронно, до 1 мин аудио), язык uk-UA. */
export function createGoogleSpeech(
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): AssistantSpeech {
  const log = new Logger("AssistantSpeech");
  return {
    enabled: Boolean(apiKey),
    async recognize(audio, mime) {
      if (!apiKey) throw new AssistantUpstreamError("config");
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
        const f = speechFailure(res.status, await res.json().catch(() => null));
        // Только коды: текст ошибки Google может повторять фрагменты запроса.
        log.warn(`Speech-to-Text: ${res.status} ${f.code}`);
        throw new AssistantUpstreamError(f.reason, res.status);
      }
      const body = (await res.json()) as RecognizeResponse;
      return (body.results ?? [])
        .map((r) => r.alternatives?.[0]?.transcript?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
    },
  };
}
