import {
  Inject,
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { isIPv6 } from "node:net";
import { from, switchMap, type Observable } from "rxjs";
import { ApiError } from "../../common/http/index.js";
import { RATE_LIMIT_RULE, RATE_LIMIT_SKIP, type RateLimitRule } from "./rate-limit.decorator.js";
import {
  RATE_LIMIT_STORE,
  type RateLimitHit,
  type RateLimitKey,
  type RateLimitStore,
} from "./rate-limit.store.js";

/**
 * IP для ключа лимита: IPv4 — как есть; IPv4-mapped (`::ffff:a.b.c.d`) — без префикса (одна корзина с IPv4);
 * IPv6 (net.isIPv6) — префикс /64 (клиенту обычно выдают целую /64, иначе обход лимита сменой адреса в подсети).
 * Нестандартные формы (IPv4-хвост вне ::ffff:, hex-mapped `::ffff:cb00:7107`) — по /64, как обычный IPv6.
 */
export function clientIpKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  const zoneless = ip.split("%")[0]!.toLowerCase();
  if (!isIPv6(zoneless) || zoneless.includes(".")) return ip;
  const [head = "", tail] = zoneless.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? headParts
      : [...headParts, ...Array<string>(8 - headParts.length - tailParts.length).fill("0"), ...tailParts];
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

export type RateLimitOptions = {
  /** false — лимиты выключены (RATE_LIMIT=off: нагрузочный тест). */
  enabled: boolean;
  /** Общий лимит на IP по всем эндпоинтам (только запросы без сессии). */
  perIp: RateLimitRule;
  /** Общий лимит пользователя с сессией по всем эндпоинтам. */
  perUser: RateLimitRule;
  /** Лимит на пользователя (без сессии — на IP) и эндпоинт, если у эндпоинта нет своего @RateLimit. */
  perEndpoint: RateLimitRule;
};

export const RATE_LIMIT_OPTIONS = Symbol("RATE_LIMIT_OPTIONS");

type LimitedRequest = {
  ip?: string;
  method: string;
  route?: { path?: string };
  principal?: { readonly userId: string };
};
type LimitedResponse = { setHeader(name: string, value: string): unknown };

/**
 * Rate limit (T1-24, ТЗ §14.4, ADR-0012): фиксированное окно. С сессией — счётчик пользователь × эндпоинт (шаблон
 * маршрута, не URL); без сессии — общий на IP (IPv6 — /64) и IP × эндпоинт, одной операцией хранилища. Превышение —
 * 429 RATE_LIMITED в конверте ошибок и Retry-After (секунды до конца окна). Глобальный интерсептор: выполняется
 * после guard'ов (принципал уже известен); /docs, /metrics и неизвестные маршруты сюда не доходят, health —
 * @SkipRateLimit. Хранилище недоступно — запрос пропускается (fail-open) с предупреждением в лог.
 * IP — `req.ip` Express: за прокси Render — из X-Forwarded-For по настройке trust proxy (configureApp).
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  private readonly logger = new Logger("RateLimit");
  private lastWarnAt = 0;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    @Inject(RATE_LIMIT_OPTIONS) private readonly options: RateLimitOptions,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.options.enabled || context.getType() !== "http") return next.handle();
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(RATE_LIMIT_SKIP, targets)) return next.handle();
    const rule =
      this.reflector.getAllAndOverride<RateLimitRule>(RATE_LIMIT_RULE, targets) ?? this.options.perEndpoint;
    const http = context.switchToHttp();
    return from(
      this.check(http.getRequest<LimitedRequest>(), http.getResponse<LimitedResponse>(), rule),
    ).pipe(switchMap(() => next.handle()));
  }

  private async check(req: LimitedRequest, res: LimitedResponse, rule: RateLimitRule): Promise<void> {
    const endpoint = `${req.method} ${req.route?.path ?? "?"}`;
    // С сессией — только пользователь × маршрут: туристы за одним Wi-Fi отеля/CGNAT делят IP, общий IP-лимит их бы
    // блокировал. Без сессии — общий лимит IP и IP × маршрут.
    const keys: RateLimitKey[] = [];
    const rules: RateLimitRule[] = [];
    if (req.principal) {
      const u = req.principal.userId;
      keys.push(
        { key: `rl:u:${u}`, windowMs: this.options.perUser.windowSec * 1000 },
        { key: `rl:ep:${endpoint}:u:${u}`, windowMs: rule.windowSec * 1000 },
      );
      rules.push(this.options.perUser, rule);
    } else {
      const ip = clientIpKey(req.ip);
      keys.push(
        { key: `rl:ip:${ip}`, windowMs: this.options.perIp.windowSec * 1000 },
        { key: `rl:ep:${endpoint}:ip:${ip}`, windowMs: rule.windowSec * 1000 },
      );
      rules.push(this.options.perIp, rule);
    }
    let hits: RateLimitHit[];
    try {
      hits = await this.store.hit(keys);
    } catch (err) {
      const now = Date.now();
      if (now - this.lastWarnAt > 60_000) {
        this.lastWarnAt = now;
        this.logger.warn(`Хранилище лимитов недоступно, запросы пропускаются: ${(err as Error).message}`);
      }
      return;
    }
    let retryMs = 0;
    hits.forEach((h, i) => {
      if (h.count > rules[i]!.limit) retryMs = Math.max(retryMs, h.resetMs);
    });
    if (retryMs > 0) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryMs / 1000))));
      throw new ApiError("RATE_LIMITED");
    }
  }
}
