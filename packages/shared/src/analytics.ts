// Каталог продуктовых событий (ТЗ §15.1, D-56, ADR-004; T1-25). Изоморфно: схема общая для фронтенда
// (эмиссия), api (приём), worker (повторная проверка перед записью) и будущей выгрузки в BI.
//
// Правила каталога:
// - имя события — snake_case `<объект>_<действие>`, как в ТЗ §15.1; новое событие — новая запись в
//   ANALYTICS_EVENTS (версия схемы не меняется: старые события остаются валидными);
// - несовместимое изменение (переименование/удаление поля, смена типа) — ANALYTICS_SCHEMA_VERSION + 1;
//   writer принимает только текущую версию, старые задачи из очереди уходят в dead-letter;
// - props строгие (лишние поля отклоняются) и без ПДн: никаких телефонов, имён, e-mail, initData Telegram,
//   точных координат, IP, свободного текста пользователя — только id сущностей, перечисления и числа.
//   Псевдоним пользователя — отдельное поле конверта, не props.
import { z } from "zod";

/** Версия схемы событий (колонка analytics_events.schema_version). */
export const ANALYTICS_SCHEMA_VERSION = 1;

/**
 * Источник входа/эмиссии (source/entry context): откуда пришёл пользователь или кто породил событие.
 * qr — QR точки входа, ambassador_link — ссылка/QR амбассадора, deep_link — прочая ссылка t.me/…?startapp,
 * bot — сообщение/кнопка бота, direct — открытие без параметра, admin — действие в админке,
 * system — фоновая задача без пользовательского касания.
 */
export const ANALYTICS_SOURCES = [
  "qr",
  "ambassador_link",
  "deep_link",
  "bot",
  "direct",
  "admin",
  "system",
] as const;
export type AnalyticsSource = (typeof ANALYTICS_SOURCES)[number];

/** Кто вправе эмитить событие: client — фронтенд через POST /analytics/events, server — только код сервера. */
export type AnalyticsEmitter = "client" | "server";

const id = z.uuid();
const platform = z.enum(["ios", "android", "web", "desktop", "unknown"]);

/**
 * Каталог: событие → кто эмитит и схема props. Состав — по ТЗ §15.1 в той части, что зафиксирована в
 * docs/discovery (flows-and-screens, implementation-backlog); props — минимальный каркас, расширяется блоком,
 * который начинает эмитить событие (новое необязательное поле — совместимо, без смены версии).
 */
export const ANALYTICS_EVENTS = {
  // Вход (блок 2, S-01).
  // qrPointId — только если точка найдена (ok, inactive); invalid — параметр не прошёл проверку формата (ADR-0016).
  qr_scanned: {
    emitter: "server",
    props: z.strictObject({
      qrPointId: id.optional(),
      result: z.enum(["ok", "inactive", "not_found", "invalid", "rate_limited"]),
    }),
  },
  // Эмитит сервер при каждом POST /auth/telegram (Mini App входит при каждом открытии, ADR-0015); от клиента — нет.
  app_opened: { emitter: "server", props: z.strictObject({ platform: platform.optional() }) },
  registration_completed: { emitter: "server", props: z.strictObject({ method: z.enum(["telegram"]) }) },
  // Каталог мест (S-01, C02, C04–C06; блок 4). Поиск — без текста запроса (свободный текст пользователя — ПДн-риск).
  category_opened: { emitter: "client", props: z.strictObject({ categoryId: id }) },
  search_used: {
    emitter: "client",
    props: z.strictObject({ categoryId: id.optional(), resultCount: z.int().min(0).optional() }),
  },
  place_viewed: { emitter: "client", props: z.strictObject({ placeId: id }) },
  route_clicked: { emitter: "client", props: z.strictObject({ placeId: id }) },
  call_clicked: { emitter: "client", props: z.strictObject({ placeId: id }) },
  // Бронирования.
  booking_created: { emitter: "server", props: z.strictObject({ bookingId: id, placeId: id }) },
  booking_confirmed: { emitter: "server", props: z.strictObject({ bookingId: id, placeId: id }) },
  booking_completed: { emitter: "server", props: z.strictObject({ bookingId: id, placeId: id }) },
  booking_cancelled: {
    emitter: "server",
    props: z.strictObject({
      bookingId: id,
      placeId: id,
      cancelledBy: z.enum(["guest", "partner", "system"]),
    }),
  },
  // Транзакции и бонусы.
  customer_qr_generated: { emitter: "server", props: z.strictObject({}) },
  transaction_started: { emitter: "server", props: z.strictObject({ transactionId: id, placeId: id }) },
  transaction_confirmed: { emitter: "server", props: z.strictObject({ transactionId: id, placeId: id }) },
  transaction_reversed: {
    emitter: "server",
    props: z.strictObject({ transactionId: id, originalTransactionId: id, placeId: id }),
  },
  // Отзывы.
  review_eligible: { emitter: "server", props: z.strictObject({ placeId: id }) },
  review_submitted: { emitter: "server", props: z.strictObject({ reviewId: id, placeId: id }) },
  review_moderated: {
    emitter: "server",
    props: z.strictObject({
      reviewId: id,
      placeId: id,
      decision: z.enum(["published", "hidden", "rejected"]),
    }),
  },
  // Амбассадоры.
  ambassador_attributed: {
    emitter: "server",
    props: z.strictObject({ ambassadorId: id, campaignId: id.optional() }),
  },
  ambassador_validated: { emitter: "server", props: z.strictObject({ ambassadorId: id }) },
  ambassador_rewarded: { emitter: "server", props: z.strictObject({ ambassadorId: id, rewardId: id }) },
} as const satisfies Record<string, { emitter: AnalyticsEmitter; props: z.ZodType<Record<string, unknown>> }>;

type Catalog = typeof ANALYTICS_EVENTS;
export type AnalyticsEventName = keyof Catalog;
export type AnalyticsEventProps<N extends AnalyticsEventName> = z.output<Catalog[N]["props"]>;
export const ANALYTICS_EVENT_NAMES = Object.keys(ANALYTICS_EVENTS) as AnalyticsEventName[];
/** События, которые фронтенд вправе прислать в POST /analytics/events. */
export type ClientAnalyticsEventName = {
  [N in AnalyticsEventName]: Catalog[N]["emitter"] extends "client" ? N : never;
}[AnalyticsEventName];
export const CLIENT_ANALYTICS_EVENT_NAMES = ANALYTICS_EVENT_NAMES.filter(
  (n) => ANALYTICS_EVENTS[n].emitter === "client",
) as ClientAnalyticsEventName[];

/** Допуск часов клиента вперёд и предел давности события (офлайн-буфер фронтенда). */
export const ANALYTICS_MAX_CLOCK_SKEW_MS = 5 * 60_000;
export const ANALYTICS_MAX_EVENT_AGE_MS = 7 * 24 * 3600_000;

/** Нулевой (nil) и максимальный UUID — заглушки, а не идентификаторы: z.uuid() их пропускает. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
/** eventId — ключ идемпотентности: рекомендуется UUIDv7 (упорядочен по времени, как id в БД — uuidv7()). */
const eventId = z.uuid().refine((v) => v !== NIL_UUID && v.toLowerCase() !== MAX_UUID, {
  message: "eventId не может быть nil или max UUID",
});

/**
 * Конверт события — обязательные поля для всех событий:
 * eventId — ключ идемпотентности (генерирует эмиттер, рекомендуется UUIDv7; nil и max UUID отклоняются;
 * повтор доставки не создаёт дубль);
 * occurredAt (ts) — момент события у источника, ISO 8601 UTC;
 * pseudonymousUserId / anonymousId — пользователь (псевдоним, не users.id) или анонимное устройство,
 * хотя бы одно; sessionId — сессия приложения; regionId — tenant (null — до определения региона);
 * source, entryContextId — источник входа и контекст входа (EntryContext, блок 2); placeId — место, если есть
 * (если задан и в конверте, и в props.placeId — должны совпадать; в журнал пишется placeId ?? props.placeId).
 *
 * Клиентский конверт (POST /analytics/events) — без pseudonymousUserId: до T1-26 его подставит сервер из сессии,
 * от клиента поле отклоняется как лишнее (strict → unrecognized_keys).
 */
const clientEnvelopeShape = {
  eventId,
  schemaVersion: z.literal(ANALYTICS_SCHEMA_VERSION),
  occurredAt: z.iso.datetime({ offset: true }),
  anonymousId: id.nullable().optional(),
  sessionId: id.nullable().optional(),
  regionId: id.nullable(),
  source: z.enum(ANALYTICS_SOURCES),
  entryContextId: id.nullable().optional(),
  placeId: id.nullable().optional(),
};
const envelopeShape = { ...clientEnvelopeShape, pseudonymousUserId: id.nullable().optional() };

type Envelope = z.output<z.ZodObject<typeof envelopeShape>>;
/** Валидное событие: конверт + props своего события (дискриминатор — event). */
export type AnalyticsEvent = {
  [N in AnalyticsEventName]: Envelope & { event: N; props: AnalyticsEventProps<N> };
}[AnalyticsEventName];
/** Событие от фронтенда: client-событие без pseudonymousUserId (его подставляет сервер, T1-26). */
export type ClientAnalyticsEvent =
  Extract<AnalyticsEvent, { event: ClientAnalyticsEventName }> extends infer E
    ? E extends unknown
      ? Omit<E, "pseudonymousUserId">
      : never
    : never;

/** placeId из props (у событий места), если есть. */
export function analyticsPropsPlaceId(props: unknown): string | undefined {
  const v = (props as { placeId?: unknown } | null | undefined)?.placeId;
  return typeof v === "string" ? v : undefined;
}

function eventSchemas(names: readonly AnalyticsEventName[], envelope: "server" | "client") {
  const shape = envelope === "server" ? envelopeShape : clientEnvelopeShape;
  const variants = names.map((n) =>
    z.strictObject({ ...shape, event: z.literal(n), props: ANALYTICS_EVENTS[n].props }),
  );
  const [first, ...rest] = variants;
  if (!first) throw new Error("Каталог событий пуст");
  return z.discriminatedUnion("event", [first, ...rest]).superRefine((value, ctx) => {
    const v = value as {
      pseudonymousUserId?: string | null;
      anonymousId?: string | null;
      placeId?: string | null;
    };
    if (v.pseudonymousUserId == null && v.anonymousId == null)
      ctx.addIssue({
        code: "custom",
        message: envelope === "server" ? "нужен pseudonymousUserId или anonymousId" : "нужен anonymousId",
        path: ["anonymousId"],
      });
    const propsPlaceId = analyticsPropsPlaceId(value.props);
    if (
      v.placeId != null &&
      propsPlaceId !== undefined &&
      v.placeId.toLowerCase() !== propsPlaceId.toLowerCase()
    )
      ctx.addIssue({
        code: "custom",
        message: "placeId конверта не совпадает с props.placeId",
        path: ["placeId"],
      });
  });
}

/** Схема любого события каталога (сервер, worker). */
export const analyticsEventSchema = eventSchemas(
  ANALYTICS_EVENT_NAMES,
  "server",
) as unknown as z.ZodType<AnalyticsEvent>;
/** Схема события от фронтенда: только client-события, конверт без pseudonymousUserId. */
export const clientAnalyticsEventSchema = eventSchemas(
  CLIENT_ANALYTICS_EVENT_NAMES,
  "client",
) as unknown as z.ZodType<ClientAnalyticsEvent>;

/** Пакет событий от фронтенда (POST /analytics/events). */
export const ANALYTICS_BATCH_MAX = 50;
export const clientAnalyticsBatchSchema = z.strictObject({
  events: z.array(clientAnalyticsEventSchema).min(1).max(ANALYTICS_BATCH_MAX),
});
export type ClientAnalyticsBatch = z.output<typeof clientAnalyticsBatchSchema>;

/** Ответ приёма пакета: сколько событий принято к записи (запись асинхронная — через очередь). */
export type AnalyticsBatchAccepted = { accepted: number };

/**
 * Проверка времени события относительно часов сервера: не из будущего (с допуском) и не старше предела.
 * Возвращает причину отказа или null.
 */
export function analyticsTimeIssue(occurredAt: string, now: Date = new Date()): string | null {
  const t = Date.parse(occurredAt);
  if (t > now.getTime() + ANALYTICS_MAX_CLOCK_SKEW_MS) return "occurredAt в будущем";
  if (t < now.getTime() - ANALYTICS_MAX_EVENT_AGE_MS) return "occurredAt старше 7 дней";
  return null;
}

/**
 * Краткое описание ошибок схемы для логов: путь и код, без значений (в отклонённом событии может быть ПДн).
 * Принимает issues zod (совместимо с ZodError.issues).
 */
export function describeAnalyticsIssues(
  issues: readonly { path: readonly PropertyKey[]; code: string }[],
): string {
  return issues
    .slice(0, 10)
    .map((i) => `${i.path.map(String).join(".") || "(корень)"}: ${i.code}`)
    .join("; ");
}
