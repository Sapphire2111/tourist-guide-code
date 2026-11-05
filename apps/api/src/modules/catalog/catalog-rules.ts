// Правила каталога без БД и Nest (блок 3, ADR-0017): переходы статусов места, готовность к публикации, проверка
// недельного графика. Сервисы вызывают их до записи; CHECK в миграции 0012 — страховка.
import type { LocalizedText, PlaceStatus } from "../../db/index.js";

/** Действия со статусом места: POST /admin/places/{id}/publish|suspend|archive. */
export type PlaceTransition = "publish" | "suspend" | "archive";

/**
 * Из каких статусов возможно действие (шаг 2 §1.6: без модерации и PlaceRevision). publish — из любого
 * неопубликованного (архив возвращается сразу в публикацию); suspend — только опубликованное; archive — любое, кроме
 * архива.
 */
export const PLACE_TRANSITIONS: Record<PlaceTransition, readonly PlaceStatus[]> = {
  publish: ["draft", "suspended", "archived"],
  suspend: ["published"],
  archive: ["draft", "published", "suspended"],
};

export const TRANSITION_TARGET: Record<PlaceTransition, PlaceStatus> = {
  publish: "published",
  suspend: "suspended",
  archive: "archived",
};

export function canTransition(from: PlaceStatus, action: PlaceTransition): boolean {
  return PLACE_TRANSITIONS[action].includes(from);
}

/**
 * Архив — только для того, что публиковалось: CHECK places_published_once (0017) не пускает archived/published/
 * suspended без first_published_at (иначе 500 из БД). Черновик, который ни разу не публиковался, удаляют
 * (DELETE /admin/places/{id}), а не архивируют.
 */
export function archiveNeedsDelete(action: PlaceTransition, firstPublishedAt: Date | null): boolean {
  return action === "archive" && firstPublishedAt === null;
}

/** Почему место нельзя опубликовать (details.problems ответа 422 errors.place.notPublishable). */
export const PUBLISH_PROBLEMS = [
  "description_missing",
  "address_missing",
  "location_missing",
  "category_inactive",
  "media_alt_missing",
  "media_rejected",
] as const;
export type PublishProblem = (typeof PUBLISH_PROBLEMS)[number];

export type PublishCheckInput = {
  place: {
    description_i18n: LocalizedText | null;
    address_i18n: LocalizedText | null;
    hasLocation: boolean;
  };
  categoryActive: boolean;
  /** Фото места: alt text (media_assets.alt_i18n) и статус обработки. */
  media: readonly { alt: LocalizedText | null; status: string }[];
};

const filled = (t: LocalizedText | null): boolean => !!t && t.uk.trim() !== "";

/**
 * Проблемы публикации; пусто — можно публиковать. Обязательны описание, адрес, точка на карте (uk — базовый язык,
 * D-05), активная категория; у каждого фото — alt text на uk (ТЗ §13 «Контент»), отклонённых фото быть не должно.
 * Фото ещё в обработке публикации не мешает: туристу (блок 4) показываются только готовые варианты.
 */
export function publishProblems(input: PublishCheckInput): PublishProblem[] {
  const problems: PublishProblem[] = [];
  if (!filled(input.place.description_i18n)) problems.push("description_missing");
  if (!filled(input.place.address_i18n)) problems.push("address_missing");
  if (!input.place.hasLocation) problems.push("location_missing");
  if (!input.categoryActive) problems.push("category_inactive");
  if (input.media.some((m) => !filled(m.alt))) problems.push("media_alt_missing");
  if (input.media.some((m) => m.status === "rejected")) problems.push("media_rejected");
  return problems;
}

/** Интервал недельного графика: день ISO (1 — пн … 7 — вс), время "HH:MM" местное. */
export type WeeklyInterval = { dayOfWeek: number; opensAt: string; closesAt: string };
export type ScheduleException = {
  date: string;
  closed: boolean;
  opensAt?: string | null;
  closesAt?: string | null;
};

export const SCHEDULE_PROBLEMS = [
  "interval_empty",
  "interval_overlap",
  "exception_times_required",
  "exception_times_forbidden",
  "exception_duplicate",
] as const;
export type ScheduleProblem = (typeof SCHEDULE_PROBLEMS)[number];

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

/**
 * Интервалы одного дня в минутах от начала дня; интервал через полночь (closes ≤ opens) занимает [opens, 24:00)
 * этого дня (остаток — утро следующего дня, на пересечения не проверяется).
 */
function overlaps(intervals: readonly { opensAt: string; closesAt: string }[]): boolean {
  const spans = intervals
    .map((i) => {
      const from = minutes(i.opensAt);
      const to = minutes(i.closesAt);
      return [from, to > from ? to : 24 * 60] as const;
    })
    .sort((a, b) => a[0] - b[0]);
  return spans.some((s, i) => i > 0 && s[0] < spans[i - 1]![1]);
}

/** Проблемы графика (422 errors.place.scheduleInvalid); формат времени и дат проверяет DTO. */
export function scheduleProblems(
  weekly: readonly WeeklyInterval[],
  exceptions: readonly ScheduleException[],
): ScheduleProblem[] {
  const problems = new Set<ScheduleProblem>();
  for (const i of weekly) if (i.opensAt === i.closesAt) problems.add("interval_empty");
  for (let day = 1; day <= 7; day++)
    if (overlaps(weekly.filter((i) => i.dayOfWeek === day))) problems.add("interval_overlap");

  const byDate = new Map<string, ScheduleException[]>();
  for (const e of exceptions) {
    if (e.closed && (e.opensAt || e.closesAt)) problems.add("exception_times_forbidden");
    if (!e.closed && (!e.opensAt || !e.closesAt)) problems.add("exception_times_required");
    if (!e.closed && e.opensAt && e.opensAt === e.closesAt) problems.add("interval_empty");
    byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  }
  for (const list of byDate.values()) {
    // Закрытый день — одна запись; открытый — непересекающиеся интервалы.
    if (list.length > 1 && list.some((e) => e.closed)) problems.add("exception_duplicate");
    const open = list.filter((e) => !e.closed && e.opensAt && e.closesAt) as {
      opensAt: string;
      closesAt: string;
    }[];
    if (new Set(open.map((e) => e.opensAt)).size < open.length) problems.add("exception_duplicate");
    else if (overlaps(open)) problems.add("interval_overlap");
  }
  return [...problems];
}

/** Шаблон для ILIKE: % и _ из запроса — буквально. */
export function likePattern(q: string): string {
  return `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// «Це мій заклад» (0031): какие категории места можно заявить партнёру.
/**
 * Категории без хозяина-бизнеса (природа, вершины, пам'ятки и храмы, лікарні, банкомати, пошта, парковки, корень
 * «Екстрена допомога»): у таких мест ссылки «Це мій заклад?» нет, заявка — 409 not_claimable. Остальные категории каталога
 * (житло, їжа, чани, прокат, підйомники й курорти, магазини, сервіси, зарядки…) — заявляемые.
 */
export const NOT_CLAIMABLE_CATEGORY_CODES: ReadonlySet<string> = new Set([
  "nature",
  "peaks",
  "sights",
  "churches",
  "viewpoints",
  "waterfalls",
  "hospitals",
  "emergency",
  "atm",
  "post",
  "parking",
]);

/**
 * Категорию можно заявить: передаётся код категории места или вся цепочка (категория и её родители) — ни один код
 * цепочки не должен быть в списке (подкатегория «Природи» тоже не заявляется). Пусто — нельзя.
 */
export function isClaimableCategory(codes: string | readonly string[] | null | undefined): boolean {
  const chain = (typeof codes === "string" ? [codes] : (codes ?? [])).filter(Boolean);
  return chain.length > 0 && chain.every((c) => !NOT_CLAIMABLE_CATEGORY_CODES.has(c));
}

/** Глубина обхода родителей категории (справочник — корень и подкатегории; запас от циклов). */
export const CATEGORY_CHAIN_MAX_DEPTH = 5;
