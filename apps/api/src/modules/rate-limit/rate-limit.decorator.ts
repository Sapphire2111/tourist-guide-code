import { SetMetadata } from "@nestjs/common";

/** Правило лимита: не больше `limit` запросов за `windowSec` секунд. */
export type RateLimitRule = { limit: number; windowSec: number };

export const RATE_LIMIT_RULE = "rateLimit:rule";
export const RATE_LIMIT_SKIP = "rateLimit:skip";

/**
 * Свой лимит эндпоинта (или всех эндпоинтов контроллера) вместо лимита по умолчанию. Считается на пользователя
 * (сессия), без сессии — на IP. Общий лимит на IP действует всё равно.
 */
export const RateLimit = (rule: RateLimitRule): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_RULE, rule);

export const RATE_LIMIT_SKIP_IP = "rateLimit:skipIp";

/**
 * Без общего лимита на IP (только лимит эндпоинта на IP/пользователя): анонимные массовые запросы вроде картинок
 * (`<img>` грузится без Bearer), которые иначе съедали бы общий бюджет IP. Потолок пользователя действует.
 */
export const SkipIpRateLimit = (): MethodDecorator & ClassDecorator => SetMetadata(RATE_LIMIT_SKIP_IP, true);

/** Без rate limit (health-проверки платформы). */
export const SkipRateLimit = (): MethodDecorator & ClassDecorator => SetMetadata(RATE_LIMIT_SKIP, true);
