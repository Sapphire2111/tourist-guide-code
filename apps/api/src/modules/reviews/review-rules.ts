// Чистая логика отзывов (блок 10; states-and-rules §6; D-08, D-37, D-82): окно права на отзыв, автофильтр текста,
// решения модератора и апелляции, формула рейтинга. Без Nest и БД.
import type { AppealKind, ReviewAutoFlag, ReviewEligibilityStatus, ReviewStatus } from "../../db/index.js";

const DAY = 24 * 3_600_000;

/** Параметры тестового режима (значения — PO; облегчённая версия блока 10). */
export const REVIEW_PARAMS = {
  /** Окно на отзыв после окончания брони, дней (D-79 не решён — параметр). */
  eligibilityWindowDays: 30,
  /** Окно правки отзыва после первой отправки, дней (D-79 не решён — параметр). */
  editWindowDays: 30,
  /** Длина текста отзыва (CHECK БД — 1…2000). */
  textMin: 1,
  textMax: 2000,
  /** Ответ партнёра (CHECK БД — 1…1000). */
  responseMax: 1000,
  /** Жалоба и апелляция (CHECK БД — 1…1000). */
  complaintTextMax: 1000,
  appealTextMax: 1000,
  /** Причина решения модератора (hidden_reason, decision_note — CHECK БД 1…500). */
  decisionReasonMax: 500,
  /** Публичный список отзывов места и список партнёра — не больше стольких. */
  publicListMax: 100,
  partnerListMax: 300,
  queueMax: 200,
} as const;

/**
 * Формула рейтинга D-37 (вариант В): байесовское сглаживание к среднему категории + затухание по давности + порог
 * минимального числа отзывов. Изменение коэффициентов или формулы — новая formulaVersion (кэш пересчитается).
 */
export const RATING_PARAMS = {
  formulaVersion: 1,
  /** До стольких опубликованных отзывов — «Мало відгуків» вместо цифры. */
  minReviews: 3,
  /** Вес априорного среднего (псевдо-отзывы). */
  priorWeight: 5,
  /** Среднее платформы — априорное для категории без отзывов. */
  globalPrior: 4,
  /** Вес среднего платформы при оценке среднего категории (мало отзывов в категории — ближе к globalPrior). */
  categoryPriorWeight: 10,
  /** Полураспад веса отзыва по давности, дней. */
  halfLifeDays: 365,
  /** Кэш старше стольких часов пересчитывается при чтении (затухание меняет рейтинг и без новых отзывов). */
  staleAfterHours: 24,
} as const;

// --- право на отзыв (D-82) ---

/** Срок права на отзыв: окончание события-основания + окно. */
export function eligibilityExpiresAt(sourceEndedAt: Date): Date {
  return new Date(sourceEndedAt.getTime() + REVIEW_PARAMS.eligibilityWindowDays * DAY);
}

/** Действующий статус: active с истёкшим окном — expired (в БД проставляется при обращении). */
export function effectiveEligibilityStatus(
  e: { status: ReviewEligibilityStatus; source_ended_at: Date },
  now: Date,
): ReviewEligibilityStatus {
  if (e.status === "active" && eligibilityExpiresAt(e.source_ended_at).getTime() <= now.getTime())
    return "expired";
  return e.status;
}

// --- автофильтр (D-08 В: ссылки, телефоны, e-mail, мат) ---

const LINK_RE =
  /(https?:\/\/|www\.|t\.me\/|\b[a-z0-9-]{2,}\.(com|net|org|ua|ru|info|io|me|biz|online|site|shop|top|xyz|pro)\b)/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
/** 9+ цифр подряд с разделителями (пробел, дефис, скобки, точка) — номер телефона. */
const PHONE_RE = /(?:\+?\d[\s\-().]{0,2}){9,}/;
/** Корни мата (начало слова) — простейший фильтр; ложные срабатывания уходят модератору, а не в отказ. */
const PROFANITY_STEMS = [
  "хуй",
  "хуя",
  "хуе",
  "хує",
  "хуї",
  "пизд",
  "пізд",
  "бляд",
  "блят",
  "ебат",
  "ебан",
  "ебал",
  "еблан",
  "єбат",
  "єбан",
  "єбал",
  "ёбан",
  "мудак",
  "мудил",
  "підар",
  "пидор",
  "пидар",
  "гандон",
  "залуп",
  "fuck",
  "shit",
  "bitch",
  "cunt",
  "asshole",
];
/** Целые слова. */
const PROFANITY_WORDS = ["бля", "сука", "суки", "суку", "курва", "курви", "курву"];
const PROFANITY_RE = new RegExp(
  `(?<!\\p{L})(?:(?:${PROFANITY_STEMS.join("|")})\\p{L}*|(?:${PROFANITY_WORDS.join("|")})(?!\\p{L}))`,
  "iu",
);

/** Срабатывания автофильтра текста (пусто — публикуется сразу). */
export function autoFlags(text: string): ReviewAutoFlag[] {
  const flags: ReviewAutoFlag[] = [];
  if (EMAIL_RE.test(text)) flags.push("email");
  // E-mail содержит домен: ссылкой считается только то, что остаётся без адресов.
  if (LINK_RE.test(text.replace(new RegExp(EMAIL_RE.source, "g"), " "))) flags.push("link");
  if (PHONE_RE.test(text)) flags.push("phone");
  if (PROFANITY_RE.test(text)) flags.push("profanity");
  return flags;
}

/** Правка отзыва ещё разрешена: не позже editWindowDays после первой отправки. */
export function editAllowed(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() <= REVIEW_PARAMS.editWindowDays * DAY;
}

/**
 * Отзыв, который модератор скрыл или отклонил, правкой в публикацию не возвращается: hidden/rejected, а также
 * pending_moderation после такой правки (признак — hidden_reason, его снимает только решение publish).
 */
export function awaitsModerator(r: { status: ReviewStatus; hidden_reason: string | null }): boolean {
  if (r.status === "hidden" || r.status === "rejected") return true;
  return r.status === "pending_moderation" && r.hidden_reason !== null;
}

/** Статус новой версии отзыва: без срабатываний — published, иначе — в очередь модерации. */
export function statusAfterSubmit(flags: readonly ReviewAutoFlag[]): ReviewStatus {
  return flags.length === 0 ? "published" : "pending_moderation";
}

// --- решения модератора (states-and-rules §6.2) ---

/** «Залишити / повернути» (publish) или «приховати» (hide). */
export type ModerationDecision = "publish" | "hide";

/**
 * Статус после решения или undefined (решение неприменимо). publish: pending_moderation → published (одобрить),
 * hidden/rejected → published (вернуть), published → published (оставить по жалобе). hide: published → hidden,
 * pending_moderation → rejected.
 */
export function decisionTarget(status: ReviewStatus, decision: ModerationDecision): ReviewStatus | undefined {
  if (decision === "publish") return "published";
  if (status === "published") return "hidden";
  if (status === "pending_moderation") return "rejected";
  return undefined;
}

/** Решение по жалобам отзыва: оставить — жалобы отклонены, скрыть — удовлетворены. */
export function complaintOutcome(decision: ModerationDecision): "upheld" | "dismissed" {
  return decision === "hide" ? "upheld" : "dismissed";
}

/**
 * Можно ли подать апелляцию (states-and-rules §6.4): автор — на hidden/rejected; партнёр — на решение «оставить»
 * (published после решения модератора по его жалобе). Без решения модератора апеллировать не к чему.
 */
export function appealAllowed(
  kind: AppealKind,
  review: { status: ReviewStatus; last_decision_by: string | null },
  partnerComplaintDismissed: boolean,
): boolean {
  if (!review.last_decision_by) return false;
  if (kind === "author") return review.status === "hidden" || review.status === "rejected";
  return review.status === "published" && partnerComplaintDismissed;
}

/** Итог удовлетворённой апелляции: автора — отзыв опубликован, партнёра — скрыт. */
export function appealGrantedStatus(kind: AppealKind): ReviewStatus {
  return kind === "author" ? "published" : "hidden";
}

// --- рейтинг (D-37 В) ---

export type RatingInput = { rating: number; publishedAt: Date };

export type RatingResult = {
  formulaVersion: number;
  reviewCount: number;
  /** Простое среднее (NULL — отзывов нет). */
  average: number | null;
  /** Сглаженный рейтинг; NULL — меньше minReviews («Мало відгуків»). */
  score: number | null;
};

/** Среднее категории, сглаженное к среднему платформы (мало отзывов в категории — ближе к globalPrior). */
export function categoryPrior(count: number, sum: number): number {
  const k = RATING_PARAMS.categoryPriorWeight;
  return (RATING_PARAMS.globalPrior * k + sum) / (k + count);
}

/** Вес отзыва по давности: 1 у нового, 0,5 через halfLifeDays. */
export function recencyWeight(publishedAt: Date, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - publishedAt.getTime()) / DAY);
  return 0.5 ** (ageDays / RATING_PARAMS.halfLifeDays);
}

/**
 * score = (priorWeight · prior + Σ wᵢ·rᵢ) / (priorWeight + Σ wᵢ), wᵢ — вес давности. Округление — до тысячных
 * (numeric(4,3) кэша).
 */
export function computeRating(reviews: readonly RatingInput[], prior: number, now: Date): RatingResult {
  const n = reviews.length;
  const average = n === 0 ? null : round3(reviews.reduce((s, r) => s + r.rating, 0) / n);
  if (n < RATING_PARAMS.minReviews)
    return { formulaVersion: RATING_PARAMS.formulaVersion, reviewCount: n, average, score: null };
  let weighted = 0;
  let weights = 0;
  for (const r of reviews) {
    const w = recencyWeight(r.publishedAt, now);
    weighted += w * r.rating;
    weights += w;
  }
  const c = RATING_PARAMS.priorWeight;
  const score = round3(Math.min(5, Math.max(1, (c * prior + weighted) / (c + weights))));
  return { formulaVersion: RATING_PARAMS.formulaVersion, reviewCount: n, average, score };
}

/** Кэш пересчитывается: другая версия формулы или расчёт старше staleAfterHours. */
export function ratingStale(cached: { formula_version: number; computed_at: Date } | undefined, now: Date) {
  if (!cached) return true;
  if (cached.formula_version !== RATING_PARAMS.formulaVersion) return true;
  return now.getTime() - cached.computed_at.getTime() > RATING_PARAMS.staleAfterHours * 3_600_000;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
