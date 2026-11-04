// Модель блока 5 на стороне Mini App: «Про заклад» (HostModule), сервисные заявки, сценарии и «Мій план».
// Экраны работают с ней, адаптер поверх @tg/api-client — host-api.ts.
import type { LocalizedText } from "@tg/i18n";
import type { WeatherDay, WeatherSource, WeatherWarning } from "../weather/weather-api.js";

export type HostService = {
  /** Код услуги (serviceCode). */
  id: string;
  title: LocalizedText;
  description: LocalizedText | null;
  /** Целевое время обработки, мин (D-55). */
  slaMinutes: number | null;
};

export type HostSection = { kind: string; title: LocalizedText; content: LocalizedText };

/** Номер комнаты: из QR номера или введён гостем (D-49 — помечается). */
export type RoomContext = { value: string; source: "qr" | "guest" };

export type HostModule = {
  placeId: string;
  name: LocalizedText;
  sections: HostSection[];
  wifi: { ssid: string; password: string | null } | null;
  phone: string | null;
  /** Часы приёма заявок «HH:MM» (местное время отеля); null — круглосуточно. */
  intake: { from: string; to: string } | null;
  /** Сейчас часы приёма. */
  acceptingNow: boolean;
  /** Номер из QR номера (null — гость вводит сам). */
  room: RoomContext | null;
  services: HostService[];
};

export const REQUEST_STATUSES = [
  "new",
  "accepted",
  "in_progress",
  "done",
  "rejected",
  "cancelled_by_guest",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export type StaffTransition = "accepted" | "in_progress" | "done" | "rejected";

export type ServiceRequest = {
  id: string;
  placeId: string;
  placeName: LocalizedText | null;
  service: LocalizedText;
  status: RequestStatus;
  statusReason: string | null;
  comment: string | null;
  room: RoomContext | null;
  createdAt: string;
  /** Создана вне часов приёма — «буде оброблено з …» (ISO). */
  processFrom: string | null;
  /** Просрочена по SLA (считает сервер). */
  overdue: boolean;
  /** Гость может отменить. */
  cancellable: boolean;
  /** Персонал: имя гостя и допустимые переходы (считает сервер). */
  guestName: string | null;
  transitions: StaffTransition[];
};

export type NewServiceRequest = {
  placeId: string;
  serviceId: string;
  comment: string | null;
  /** Номер, введённый гостем; при QR номера сервер берёт его из entryContextId. */
  roomLabel: string | null;
  entryContextId: string | null;
  /** Один ключ на форму: повтор после сбоя сети не создаст дубль. */
  idempotencyKey: string;
};

export type ScenarioSummary = {
  id: string;
  title: LocalizedText;
  description: LocalizedText | null;
  days: number;
  adLabel: "advertising" | "partner" | null;
};

export type PlanPlace = { id: string; name: LocalizedText };

/** Часть дня плана; rain — запасной план «якщо дощ». */
export type PlanSlot = "morning" | "afternoon" | "evening" | "rain";
export const PLAN_SLOTS: readonly PlanSlot[] = ["morning", "afternoon", "evening", "rain"];

export type PlanItem = {
  id: string;
  /** «HH:MM» или null. */
  time: string | null;
  /** null — место недоступно: «Недоступно. Замінити». */
  place: PlanPlace | null;
  note: LocalizedText | null;
  alternatives: PlanPlace[];
  distanceMeters: number | null;
  /** Часть дня (у пунктов сценария — по времени). */
  slot: PlanSlot;
  /** Горный поход в день с опасной погодой (только у пунктов плана); пусто — нет предупреждений. */
  weatherWarnings?: WeatherWarning[];
};

/** Погода дня плана: rainy — раскрыть «якщо дощ», noMountains — горные походы не предлагаются. */
export type PlanDayWeather = WeatherDay & { day: number; noMountains: boolean };

/** Почему вариант подходит (ключ текста miniapp.plan.reason.*). */
export type PlanOptionReason =
  | "breakfast"
  | "lunch"
  | "dinner"
  | "evening_out"
  | "walk"
  | "culture"
  | "active"
  | "fun"
  | "relax"
  | "shopping"
  | "indoor";

/** Вариант на выбор — настоящее место каталога. */
export type PlanOption = {
  place: PlanPlace & { categoryName: LocalizedText };
  /** Код подкатегории или waterfall / bar (по названию из Google). */
  kind: string;
  reason: PlanOptionReason;
  distanceMeters: number | null;
  /** walk — пішки, car — на авто, transport — без авто далеко; null — не від чого рахувати. */
  travel: "walk" | "car" | "transport" | null;
  travelMinutes: number | null;
  kidsFriendly: boolean;
};

export type PlanDayOptions = { day: number; slots: { slot: PlanSlot; options: PlanOption[] }[] };

/** Параметры поездки. */
/** Интересы для живого плана (planner.ai) — теги сценариев, которые турист выбирает в форме. */
export const PLAN_INTERESTS = ["waterfalls", "hiking", "culture", "gastro", "relax", "active"] as const;
export type PlanInterest = (typeof PLAN_INTERESTS)[number];

export type PlanTrip = {
  /** Интересы (только при флаге planner.ai); нет — без интересов. */
  interests?: PlanInterest[];
  adults: number;
  children: number;
  withCar: boolean;
  days: number;
};

export type TripInput = PlanTrip & {
  startDate?: string | null;
  basePlaceId?: string | null;
  /** false — без Claude (флаг planner.ai): места добавит клиент. */
  ai?: boolean;
};

export type PlanDay = { day: number; items: PlanItem[] };

export type ScenarioDetail = ScenarioSummary & { schedule: PlanDay[] };

export type UserPlan = {
  id: string;
  scenarioId: string | null;
  title: LocalizedText;
  schedule: PlanDay[];
  scenarioUpdated: boolean;
  updatedAt: string;
  startDate: string | null;
  trip: PlanTrip;
  /** От чего считается расстояние, если в день ещё ничего не выбрано. */
  base: LocalizedText | null;
  /** Варианты на выбор (только у одного плана; в списке — пусто). */
  options: PlanDayOptions[];
  /** Погода по дням (только у одного плана, при дате начала и в пределах прогноза). */
  weather: PlanDayWeather[];
  weatherSource: WeatherSource | null;
  /** Только в ответе создания и «Інший варіант»: ai — склав Claude, fallback — правиловий план, null — без Claude. */
  generation: "ai" | "fallback" | null;
};

export type PlanChange =
  | { replace: { itemId: string; placeId: string } }
  | { remove: string }
  | { add: { day: number; slot: PlanSlot; placeId: string } }
  | { trip: Partial<TripInput> };

/** Ошибка api: код и messageKey из конверта ошибки сервера; details — например, текущий статус при 409. */
export class ApiCallError extends Error {
  constructor(
    public readonly status: number,
    public readonly messageKey: string | null,
    public readonly code: string | null = null,
    public readonly details: Record<string, unknown> | null = null,
  ) {
    super(`HTTP ${status}`);
  }
}

/** Конфликт (409): недопустимый переход статуса, дубль активной заявки или IDEMPOTENCY_IN_PROGRESS. */
export class ConflictError extends ApiCallError {
  constructor(
    messageKey: string | null = null,
    code: string | null = "CONFLICT",
    details: Record<string, unknown> | null = null,
  ) {
    super(409, messageKey, code, details);
  }
}

/** Ответа нет (сеть) — исход запроса неизвестен; повтор — с тем же Idempotency-Key. */
export class NetworkError extends Error {
  constructor() {
    super("network");
  }
}

/** Исход записи неизвестен: сеть, 5xx, 429. */
export function isAmbiguous(err: unknown): boolean {
  return (
    err instanceof NetworkError || (err instanceof ApiCallError && (err.status >= 500 || err.status === 429))
  );
}

export type HostApi = {
  hostModule(placeId: string, entryContextId: string | null): Promise<HostModule>;
  createRequest(req: NewServiceRequest): Promise<ServiceRequest>;
  myRequests(): Promise<ServiceRequest[]>;
  cancelRequest(id: string): Promise<ServiceRequest>;
  staffRequests(status: RequestStatus | null): Promise<ServiceRequest[]>;
  setStatus(id: string, status: StaffTransition, reason: string | null): Promise<ServiceRequest>;
  /** Сценарии региона; tripDate (YYYY-MM-DD) — сезон поездки, без неё — текущий сезон (решает api). */
  scenarios(tripDate?: string | null): Promise<ScenarioSummary[]>;
  scenario(id: string): Promise<ScenarioDetail>;
  plans(): Promise<UserPlan[]>;
  plan(id: string): Promise<UserPlan>;
  /** «Зберегти як план»: план из сценария. */
  /** startDate (YYYY-MM-DD) — дата поездки: варианты плана — по её сезону. */
  /** idempotencyKey — повтор после неясного исхода с тем же ключом не создаёт второй план (по умолчанию новый). */
  savePlan(scenarioId: string, startDate?: string | null, idempotencyKey?: string): Promise<UserPlan>;
  /** «Скласти свій план»: без сценария, с параметрами поездки. */
  createPlan(trip: TripInput, idempotencyKey?: string): Promise<UserPlan>;
  /** «Інший варіант»: новий план через Claude з тими ж параметрами (флаг planner.ai). */
  regeneratePlan(id: string, idempotencyKey?: string): Promise<UserPlan>;
  updatePlan(id: string, change: PlanChange): Promise<UserPlan>;
};
