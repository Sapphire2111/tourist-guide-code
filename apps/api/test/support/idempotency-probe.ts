// Тестовые эндпоинты с @Idempotent() (T1-14): только для тестов, в боевом приложении и OpenAPI их нет.
// Счётчик effects — сколько раз реально выполнился обработчик; hold — задержать обработчик (параллельные запросы).
import { Body, Controller, HttpCode, HttpException, Post } from "@nestjs/common";
import { ApiError } from "../../src/common/http/index.js";
import { currentTenant, type TenantContext } from "../../src/db/index.js";
import { Idempotent } from "../../src/modules/idempotency/index.js";

type Effect = "payments" | "refunds" | "rejected" | "broken" | "transient" | "strict" | "plain";

const NO_EFFECTS: Record<Effect, number> = {
  payments: 0,
  refunds: 0,
  rejected: 0,
  broken: 0,
  transient: 0,
  strict: 0,
  plain: 0,
};

@Controller("t114")
export class IdempotencyProbeController {
  effects: Record<Effect, number> = { ...NO_EFFECTS };
  /** Если задан — обработчик payments ждёт его перед ответом. */
  hold: Promise<void> | undefined;
  /** Вызывается при входе в обработчик payments (до hold) — сигнал «ключ уже захвачен». */
  entered: (() => void) | undefined;
  /** Статус, который бросает transient (пока broken). */
  transientStatus = 429;
  /** broken и transient бросают ошибку, пока true. */
  broken = true;
  /** Tenant-контекст, в котором выполнялся последний обработчик. */
  lastTenant: TenantContext | undefined;

  reset(): void {
    this.effects = { ...NO_EFFECTS };
    this.entered = undefined;
    this.transientStatus = 429;
    this.hold = undefined;
    this.broken = true;
    this.lastTenant = undefined;
  }

  @Post("payments")
  @Idempotent({ allowAnonymous: true })
  async pay(@Body() body: { amountMinor?: number }) {
    const n = ++this.effects.payments;
    this.lastTenant = currentTenant();
    this.entered?.();
    await this.hold;
    return { paymentId: `p${n}`, amountMinor: body.amountMinor, at: new Date(0) };
  }

  @Post("refunds")
  @HttpCode(200)
  @Idempotent({ ttlSeconds: 60, allowAnonymous: true })
  refund() {
    return { refundId: `r${++this.effects.refunds}` };
  }

  @Post("rejected")
  @Idempotent({ allowAnonymous: true })
  reject(): never {
    this.effects.rejected++;
    throw new ApiError("CONFLICT", { messageKey: "errors.t114.rejected", details: { reason: "limit" } });
  }

  @Post("broken")
  @Idempotent({ allowAnonymous: true })
  breakdown() {
    const n = ++this.effects.broken;
    if (this.broken) throw new Error("сбой обработчика");
    return { attempt: n };
  }

  @Post("transient")
  @Idempotent({ allowAnonymous: true })
  transient() {
    const n = ++this.effects.transient;
    if (this.broken) throw new HttpException("временно", this.transientStatus);
    return { attempt: n };
  }

  /** Без allowAnonymous: нужен req.user (в тестах — middleware по заголовку x-test-user). */
  @Post("strict")
  @Idempotent()
  strict() {
    return { strict: ++this.effects.strict };
  }

  @Post("plain")
  plain() {
    return { plain: ++this.effects.plain };
  }
}
