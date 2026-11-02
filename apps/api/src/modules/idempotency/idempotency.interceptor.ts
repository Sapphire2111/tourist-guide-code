import {
  Inject,
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants.js";
import { Reflector } from "@nestjs/core";
import type { ErrorCode } from "@tg/shared";
import { from, lastValueFrom, type Observable } from "rxjs";
import { ApiError, toErrorResponse, type HttpRequest } from "../../common/http/index.js";
import { currentTenant } from "../../db/index.js";
import { IDEMPOTENCY_STORE, type IdempotencyStore } from "./idempotency-keys.repository.js";
import {
  ANONYMOUS_ACTOR,
  decideExisting,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  idempotencyActor,
  idempotencyScope,
  IN_PROGRESS_RETRY_AFTER_SECONDS,
  parseIdempotencyKey,
  requestHash,
  type StoredResponse,
} from "./idempotency.js";
import { IDEMPOTENT_METADATA, type IdempotentOptions } from "./idempotent.decorator.js";

type Request = HttpRequest & {
  method: string;
  originalUrl?: string;
  url: string;
  body?: unknown;
  user?: unknown;
};
type Response = { setHeader(name: string, value: string): unknown };

/**
 * Глобальный интерсептор эндпоинтов с `@Idempotent()` (T1-14). Должен стоять СНАРУЖИ TenantContextInterceptor
 * (IdempotencyModule импортируется раньше TenancyModule — порядок глобальных интерсепторов = порядок модулей):
 * захват ключа — отдельная автокоммит-команда до транзакции запроса, поэтому параллельный запрос с тем же ключом
 * сразу видит in_progress; ответ сохраняется после COMMIT бизнес-транзакции — сохранённый ответ не появится для
 * откаченного эффекта. Неверный порядок — ошибка 500 на первом же запросе с tenant-контекстом.
 *
 * Ответы: 2xx и 4xx сохраняются и повторяются (4xx — с тем же code/messageKey/details и новым correlationId);
 * 5xx, 408, 429 и неизвестные ошибки → ключ `failed`, повтор с тем же телом выполнит обработчик снова. Потоковые ответы
 * (SSE) и `@Res()` не поддерживаются.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger("Idempotency");

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<Required<IdempotentOptions> | undefined>(
      IDEMPOTENT_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!options || context.getType() !== "http") return next.handle();
    return from(this.handle(context, next, options));
  }

  private async handle(
    context: ExecutionContext,
    next: CallHandler,
    options: Required<IdempotentOptions>,
  ): Promise<unknown> {
    if (currentTenant())
      throw new Error(
        "IdempotencyInterceptor выполняется внутри withTenant(): импортируйте IdempotencyModule раньше TenancyModule",
      );
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const key = parseIdempotencyKey(req.headers[IDEMPOTENCY_KEY_HEADER]);
    if (key === undefined) throw new ApiError("IDEMPOTENCY_KEY_REQUIRED");
    const actor = idempotencyActor(req) ?? (options.allowAnonymous ? ANONYMOUS_ACTOR : undefined);
    if (actor === undefined)
      throw new Error(
        `@Idempotent ${req.method} ${req.originalUrl ?? req.url}: нет аутентифицированного актора (req.user) — ` +
          "актора должен выставить guard/middleware до интерсептора, либо @Idempotent({ allowAnonymous: true })",
      );
    const scope = idempotencyScope(actor, req.method, req.originalUrl ?? req.url);
    const hash = requestHash(req.body);

    const claim = await this.store.claim({ scope, key, requestHash: hash, ttlSeconds: options.ttlSeconds });
    if (!claim.acquired) {
      const decision = claim.row ? decideExisting(claim.row, hash) : { kind: "in_progress" as const };
      if (decision.kind === "mismatch") throw new ApiError("IDEMPOTENCY_KEY_REUSED");
      if (decision.kind === "in_progress") {
        res.setHeader("Retry-After", String(IN_PROGRESS_RETRY_AFTER_SECONDS));
        throw new ApiError("IDEMPOTENCY_IN_PROGRESS");
      }
      res.setHeader(IDEMPOTENT_REPLAYED_HEADER, "true");
      return replay(decision.status, decision.body);
    }

    const id = claim.row.id;
    let result: unknown;
    try {
      result = await lastValueFrom(next.handle(), { defaultValue: undefined });
    } catch (err) {
      const { status, code, messageKey, details } = toErrorResponse(err);
      if (!isTransient(status)) {
        const error = details === undefined ? { code, messageKey } : { code, messageKey, details };
        await this.persist(() => this.store.complete(id, status, { error }), scope, key);
      } else await this.persist(() => this.store.fail(id), scope, key);
      throw err;
    }
    const value = toJson(result);
    await this.persist(
      () =>
        this.store.complete(
          id,
          this.successStatus(context, req.method),
          value === undefined ? {} : { value },
        ),
      scope,
      key,
    );
    return result;
  }

  /** Статус успешного ответа, как его выставит Nest: @HttpCode или 201 для POST, иначе 200. */
  private successStatus(context: ExecutionContext, method: string): number {
    const code = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler());
    return code ?? (method.toUpperCase() === "POST" ? 201 : 200);
  }

  /**
   * Ошибка записи результата не меняет ответ клиенту (эффект уже применён): ключ остаётся in_progress до
   * истечения TTL, повторы получают 409 — безопаснее, чем выполнить эффект ещё раз.
   */
  private async persist(write: () => Promise<void>, scope: string, key: string): Promise<void> {
    try {
      await write();
    } catch (err) {
      this.logger.error(
        `Не удалось сохранить результат ключа scope=${scope} key=${key}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}

/** Повтор сохранённого ответа: успех — значение (статус задаст @HttpCode обработчика, как в первый раз), 4xx — та же ошибка. */
function replay(status: number, body: StoredResponse): unknown {
  if ("error" in body) {
    const { code, messageKey, details } = body.error;
    throw new ApiError(code as ErrorCode, { messageKey, details, status });
  }
  return body.value;
}

/** Временные ошибки (5xx, 408 таймаут, 429 лимит): ключ `failed`, повтор выполнит обработчик снова. */
function isTransient(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/** JSON-форма результата (как его сериализует ответ): Date → строка, undefined-поля опущены. */
function toJson(result: unknown): unknown {
  return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
}
