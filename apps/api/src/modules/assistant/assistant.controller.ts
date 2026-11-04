import { Body, Controller, HttpCode, Inject, Post, Query, Req, Res } from "@nestjs/common";
import { ApiBody, ApiConsumes, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { Readable } from "node:stream";
import { ApiError, ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { RequireAuth } from "../auth/index.js";
import { RequireFeature, type FeatureRegionResolver } from "../feature-flags/index.js";
import { originOf } from "../guide/index.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { RegionQueryDto } from "../guide/index.js";
import { RateLimit } from "../rate-limit/index.js";
import type { RbacRequest } from "../rbac/index.js";
import {
  ASSISTANT_AUDIO_MAX_BYTES,
  ASSISTANT_TEXT_MAX,
  AssistantResultDto,
  AssistantTranscriptDto,
} from "./assistant.dto.js";
// Классы DTO запросов нужны в рантайме: emitDecoratorMetadata передаёт их в ValidationPipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { AssistantQueryDto } from "./assistant.dto.js";
import { AssistantService } from "./assistant.service.js";
import { AUDIO_MIMES, type AudioMime } from "./providers.js";

// Ассистент на главной Mini App (флаг module.assistant, выключен — 404). Только с сессией (вход через Telegram):
// каждое обращение стоит денег (Claude, Speech-to-Text) — лимиты на пользователя и суточный предел процесса.
// Регион — из запроса, как у гида. Текст и аудио туриста не логируются и не сохраняются.

/** Разбор запроса: на пользователя в минуту. */
export const ASSISTANT_QUERY_RATE_LIMIT = { limit: 12, windowSec: 60 } as const;
/** Распознавание речи: на пользователя в минуту. */
export const ASSISTANT_TRANSCRIBE_RATE_LIMIT = { limit: 6, windowSec: 60 } as const;

const touristRegion: FeatureRegionResolver = ({ request }) => {
  const q = request.query?.regionId;
  if (typeof q === "string") return q;
  const b = request.body as { regionId?: unknown } | undefined;
  return typeof b?.regionId === "string" ? b.regionId : undefined;
};

type StreamRequest = Readable & { headers: Record<string, string | string[] | undefined> };

/**
 * Тело запроса до max байт; больше — 413: чтение прекращается (остаток не принимается), соединение закрывается
 * после ответа (Connection: close у ответа ставит вызывающий) — без обрыва сокета до отправки 413.
 */
export function readLimited(req: Readable, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer | string) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += b.length;
      if (size > max) {
        cleanup();
        req.pause();
        reject(tooLarge());
        return;
      }
      chunks.push(b);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (e: unknown) => {
      cleanup();
      reject(e);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

const tooLarge = () =>
  new ApiError("BAD_REQUEST", {
    status: 413,
    messageKey: "errors.assistant.audioTooLarge",
    details: { reason: "too_large", maxBytes: ASSISTANT_AUDIO_MAX_BYTES },
  });

/** «audio/webm;codecs=opus» → audio/webm; неподдерживаемый формат — undefined. */
export function audioMimeOf(contentType: string | string[] | undefined): AudioMime | undefined {
  const base = String(contentType ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  return (AUDIO_MIMES as readonly string[]).includes(base) ? (base as AudioMime) : undefined;
}

@ApiTags("assistant")
@Controller("assistant")
@RequireAuth()
@WithoutTenantContext()
@RequireFeature("module.assistant", { region: touristRegion })
export class AssistantController {
  constructor(@Inject(AssistantService) private readonly assistant: AssistantService) {}

  @Post("query")
  @HttpCode(200)
  @RateLimit(ASSISTANT_QUERY_RATE_LIMIT)
  @ApiOperation({
    operationId: "assistantQuery",
    summary: "Ассистент: реплика туриста → намерение и реальные места каталога (или маршрут экскурсии)",
    description:
      `Текст до ${ASSISTANT_TEXT_MAX} символов. Модель (Claude, tool use) выбирает только коды категорий и фильтры; ` +
      "места, цены и описания — из каталога и обогащения. Контекст диалога (history, previous) присылает клиент. " +
      "intent.clarify — запрос непонятен (мест нет). 503 errors.assistant.unavailable — нет ключа Claude или " +
      `исчерпан суточный предел; 502/504 — сбой Claude. Rate limit ${ASSISTANT_QUERY_RATE_LIMIT.limit}/мин. ` +
      "404 — флаг module.assistant выключен, региона нет или он не активен.",
  })
  @ApiOkResponse({ type: AssistantResultDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "UNAUTHENTICATED",
    "NOT_FOUND",
    "RATE_LIMITED",
    "SERVICE_UNAVAILABLE",
    "BAD_GATEWAY",
    "GATEWAY_TIMEOUT",
  )
  query(@Body() body: AssistantQueryDto, @Req() req: RbacRequest): Promise<AssistantResultDto> {
    const text = body.text.trim();
    if (!text)
      throw new ApiError("VALIDATION_FAILED", {
        details: {
          fields: [{ field: "text", constraint: "isNotEmpty", messageKey: "errors.validation.isNotEmpty" }],
        },
      });
    return this.assistant.query(body.regionId, userOf(req), {
      text,
      origin: originOf(body),
      history: (body.history ?? []).map((h) => h.trim()).filter(Boolean),
      // Намерение прошлого ответа: поля, которых не было у старых клиентов, — по умолчанию.
      previous: body.previous
        ? {
            ...body.previous,
            locality: body.previous.locality ?? null,
            keywords: body.previous.keywords ?? [],
            days: body.previous.days ?? null,
            dayParts: body.previous.dayParts ?? [],
            start: body.previous.start ?? null,
            related: body.previous.related ?? [],
            scope: body.previous.scope ?? null,
            sort: body.previous.sort ?? null,
            scopeLocalityIds: body.previous.scopeLocalityIds ?? [],
            transport: body.previous.transport ?? null,
          }
        : null,
      localityIds: body.localityIds ?? [],
      answer: body.answer === true,
    });
  }

  @Post("transcribe")
  @HttpCode(200)
  @RateLimit(ASSISTANT_TRANSCRIBE_RATE_LIMIT)
  @ApiOperation({
    operationId: "assistantTranscribe",
    summary: "Ассистент: голос → текст (Google Speech-to-Text, uk-UA)",
    description:
      "Тело — запись MediaRecorder (Opus в audio/webm или audio/ogg), до " +
      `${ASSISTANT_AUDIO_MAX_BYTES / 1024} КиБ (больше — 413). Аудио не сохраняется. Пустой text — речь не ` +
      "распознана. 415 — другой формат (например, audio/mp4 из iOS) — ввести текстом. 503 — нет ключа Google или " +
      `исчерпан суточный предел. Rate limit ${ASSISTANT_TRANSCRIBE_RATE_LIMIT.limit}/мин.`,
  })
  @ApiQuery({ name: "regionId", type: String, required: true, description: "Регион туриста (uuid)" })
  @ApiConsumes(...AUDIO_MIMES)
  @ApiBody({ schema: { type: "string", format: "binary" } })
  @ApiOkResponse({ type: AssistantTranscriptDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "BAD_REQUEST",
    "UNAUTHENTICATED",
    "NOT_FOUND",
    "UNPROCESSABLE",
    "RATE_LIMITED",
    "SERVICE_UNAVAILABLE",
    "BAD_GATEWAY",
    "GATEWAY_TIMEOUT",
  )
  async transcribe(
    @Query() q: RegionQueryDto,
    @Req() req: StreamRequest & RbacRequest,
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): unknown },
  ): Promise<AssistantTranscriptDto> {
    const mime = audioMimeOf(req.headers["content-type"]);
    if (!mime)
      throw new ApiError("BAD_REQUEST", {
        status: 415,
        messageKey: "errors.assistant.audioFormat",
        details: { reason: "unsupported_media_type", accepted: [...AUDIO_MIMES] },
      });
    const declared = Number(req.headers["content-length"]);
    let audio: Buffer;
    try {
      if (Number.isFinite(declared) && declared > ASSISTANT_AUDIO_MAX_BYTES) throw tooLarge();
      audio = await readLimited(req, ASSISTANT_AUDIO_MAX_BYTES);
    } catch (e) {
      // Непрочитанный остаток тела — не ждём: соединение закроется после ответа 413.
      res.setHeader("Connection", "close");
      throw e;
    }
    if (!audio.length)
      throw new ApiError("BAD_REQUEST", {
        messageKey: "errors.assistant.audio",
        details: { reason: "empty" },
      });
    return { text: await this.assistant.transcribe(q.regionId, userOf(req), audio, mime) };
  }
}

function userOf(req: RbacRequest): string {
  const userId = req.principal?.userId;
  if (!userId) throw new ApiError("UNAUTHENTICATED");
  return userId;
}
