import { HttpException } from "@nestjs/common";
import { ERROR_HTTP_STATUS, ERROR_MESSAGE_KEYS, type ErrorCode, type ErrorEnvelope } from "@tg/shared";

type Details = ErrorEnvelope["error"]["details"];

/**
 * Прикладная ошибка с кодом из @tg/shared. Бросается из сервисов/контроллеров:
 * `throw new ApiError("CONFLICT", { messageKey: "errors.booking.slotTaken" })`.
 * Глобальный фильтр превращает её в единый конверт. `status` — только для воспроизведения сохранённого ответа
 * (повтор по Idempotency-Key, T1-14): 4xx, не совпадающий с ERROR_HTTP_STATUS[code] (например, 413 c BAD_REQUEST).
 * Допустим только 400–499: 5xx задаётся кодом ошибки, а не статусом.
 */
export class ApiError extends HttpException {
  readonly code: ErrorCode;
  readonly messageKey: string;
  readonly details: Details;

  constructor(
    code: ErrorCode,
    opts: { messageKey?: string; details?: Details; cause?: unknown; status?: number } = {},
  ) {
    if (
      opts.status !== undefined &&
      !(Number.isInteger(opts.status) && opts.status >= 400 && opts.status <= 499)
    )
      throw new Error(`ApiError: status должен быть 400–499, получено ${opts.status}`);
    super(code, opts.status ?? ERROR_HTTP_STATUS[code], { cause: opts.cause });
    this.code = code;
    this.messageKey = opts.messageKey ?? ERROR_MESSAGE_KEYS[code];
    this.details = opts.details;
  }
}
