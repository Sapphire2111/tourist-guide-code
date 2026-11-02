// Каталог фича-флагов (T1-22, ADR-0011): источник истины — этот файл. Значение флага по умолчанию задано для
// каждого окружения (APP_ENV); админ платформы переопределяет его на всё окружение или на регион (таблица
// feature_flags, миграция 0008). Новый флаг — сюда (и в README apps/api, «Фича-флаги»); миграция не нужна.
// Чистая логика без Nest и БД.
import { APP_ENVS, type AppEnv } from "@tg/server-config";

export { APP_ENVS, type AppEnv };

export type FeatureFlagDefinition = {
  readonly description: string;
  /** Значение по умолчанию в окружении, если переопределения нет. */
  readonly defaults: Readonly<Record<AppEnv, boolean>>;
  /**
   * Флаги, без которых этот не действует: эффективное значение = собственное И все required. Например, модуль
   * бронирований выключен, пока выключен release.mvp, даже если сам флаг модуля включён.
   */
  readonly requires: readonly FeatureFlagKey[];
  /** Финансовый гейт (D-81): включение в prod — только SUPERADMIN после отметок о закрытии ⚖-решений. */
  readonly financeGate: boolean;
};

const ON = { local: true, staging: true, prod: false } as const;
const OFF = { local: false, staging: false, prod: false } as const;
const ALWAYS = { local: true, staging: true, prod: true } as const;

function flag(
  description: string,
  defaults: Readonly<Record<AppEnv, boolean>>,
  requires: readonly FeatureFlagKey[] = [],
  financeGate = false,
): FeatureFlagDefinition {
  return Object.freeze({ description, defaults, requires, financeGate });
}

/** Ключи флагов: `release.*`, `finance.*`, `module.*`. */
export const FEATURE_FLAG_KEYS = [
  "release.r1",
  "release.mvp",
  "finance.engine",
  "finance.live",
  "module.host_requests",
  "module.partner_cabinet",
  "module.bookings",
  "module.qr_transactions",
  "module.reviews",
  "module.ambassadors",
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

/**
 * Флаги. Релизные (`release.*`) и финансовые (`finance.*`) — по implementation-backlog §1.2 и финансовому гейту;
 * флаги модулей (`module.*`) — по блокам 5–11, каждый зависит от релиза, в который входит модуль. Модули по
 * умолчанию включены: в prod их держит выключенными релизный флаг.
 */
export const FEATURE_FLAGS: Readonly<Record<FeatureFlagKey, FeatureFlagDefinition>> = Object.freeze({
  "release.r1": flag("Релиз R1 (блоки 1–5)", ON),
  "release.mvp": flag("Релиз MVP (блоки 1–12)", ON, ["release.r1"]),
  "finance.engine": flag("Финансовое ядро: движок бонусов и расчётов (блоки 8–9)", ON, ["release.mvp"]),
  "finance.live": flag(
    "Финансы на реальных деньгах и партнёрах — только после закрытия ⚖-решений (D-81)",
    OFF,
    ["finance.engine"],
    true,
  ),
  "module.host_requests": flag("Заявки гостиницы и планировщик (блок 5)", ALWAYS, ["release.r1"]),
  "module.partner_cabinet": flag("Партнёрский кабинет (блок 6)", ALWAYS, ["release.mvp"]),
  "module.bookings": flag("Бронирования (блок 7)", ALWAYS, ["release.mvp"]),
  "module.qr_transactions": flag("QR-транзакции и взаиморасчёты (блок 9)", ALWAYS, ["finance.engine"]),
  "module.reviews": flag("Подтверждённые отзывы (блок 10)", ALWAYS, ["release.mvp"]),
  "module.ambassadors": flag("Амбассадоры (блок 11)", ALWAYS, ["release.mvp"]),
});

export function isFeatureFlagKey(key: string): key is FeatureFlagKey {
  return (FEATURE_FLAG_KEYS as readonly string[]).includes(key);
}

/**
 * ⚖-решения, закрытие которых отмечается перед включением finance.live в prod (decisions.md §2.1, D-81).
 * Отметка — запись feature_flag_gate_marks со ссылкой на документ.
 */
export const FINANCE_GATE_DECISIONS = ["D-09", "D-10", "D-13", "D-17", "D-20", "D-24"] as const;
export type FinanceGateDecision = (typeof FINANCE_GATE_DECISIONS)[number];

export function isFinanceGateDecision(code: string): code is FinanceGateDecision {
  return (FINANCE_GATE_DECISIONS as readonly string[]).includes(code);
}

/**
 * Роль, которая единственная может включить флаг финансового гейта в prod (назначение на PLATFORM). Условия гейта —
 * ADR-0011/0018.
 */
export const FINANCE_GATE_ROLE = "SUPERADMIN";

/** Переопределения: на окружение (`global`) и на регион (`region`); undefined — нет переопределения. */
export type FlagOverrides = {
  readonly global: Readonly<Partial<Record<FeatureFlagKey, boolean>>>;
  readonly region: Readonly<Partial<Record<FeatureFlagKey, boolean>>>;
};

export const NO_OVERRIDES: FlagOverrides = Object.freeze({ global: {}, region: {} });

/** Собственное значение флага: переопределение региона → переопределение окружения → значение по умолчанию. */
export function rawValue(key: FeatureFlagKey, env: AppEnv, overrides: FlagOverrides): boolean {
  return overrides.region[key] ?? overrides.global[key] ?? FEATURE_FLAGS[key].defaults[env];
}

/** Эффективные значения всех флагов: собственное значение И эффективные значения флагов из requires. */
export function evaluateFlags(env: AppEnv, overrides: FlagOverrides): Record<FeatureFlagKey, boolean> {
  const out = {} as Record<FeatureFlagKey, boolean>;
  const visit = (key: FeatureFlagKey, path: readonly FeatureFlagKey[]): boolean => {
    if (key in out) return out[key];
    if (path.includes(key)) throw new Error(`Цикл в requires фича-флагов: ${[...path, key].join(" → ")}`);
    const value =
      rawValue(key, env, overrides) && FEATURE_FLAGS[key].requires.every((r) => visit(r, [...path, key]));
    out[key] = value;
    return value;
  };
  for (const key of FEATURE_FLAG_KEYS) visit(key, []);
  return out;
}
