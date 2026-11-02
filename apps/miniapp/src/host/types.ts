// Модель блока 5 на стороне Mini App: «Про заклад» (HostModule), сервисные заявки, сценарии и «Мій план».
// Экраны работают с ней, адаптер поверх @tg/api-client — host-api.ts.
import type { LocalizedText } from "@tg/i18n";

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

export type PlanItem = {
  id: string;
  /** «HH:MM» или null. */
  time: string | null;
  /** null — место недоступно: «Недоступно. Замінити». */
  place: PlanPlace | null;
  note: LocalizedText | null;
  alternatives: PlanPlace[];
  distanceMeters: number | null;
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
};

export type PlanChange = { replace: { itemId: string; placeId: string } } | { remove: string };

/** Ошибка api с messageKey сервера (409 конфликт, 422 и т.п.). */
export class ApiCallError extends Error {
  constructor(
    public readonly status: number,
    public readonly messageKey: string | null,
  ) {
    super(`HTTP ${status}`);
  }
}

/** Конфликт (409): недопустимый переход статуса или дубль активной заявки. */
export class ConflictError extends ApiCallError {
  constructor(messageKey: string | null = null) {
    super(409, messageKey);
  }
}

export type HostApi = {
  hostModule(placeId: string, entryContextId: string | null): Promise<HostModule>;
  createRequest(req: NewServiceRequest): Promise<ServiceRequest>;
  myRequests(): Promise<ServiceRequest[]>;
  cancelRequest(id: string): Promise<ServiceRequest>;
  /** Есть ли у пользователя места, где он персонал (D-50). */
  isStaff(): Promise<boolean>;
  staffRequests(status: RequestStatus | null): Promise<ServiceRequest[]>;
  setStatus(id: string, status: StaffTransition, reason: string | null): Promise<ServiceRequest>;
  scenarios(): Promise<ScenarioSummary[]>;
  scenario(id: string): Promise<ScenarioDetail>;
  plans(): Promise<UserPlan[]>;
  plan(id: string): Promise<UserPlan>;
  /** «Зберегти як план»: план из сценария. */
  savePlan(scenarioId: string): Promise<UserPlan>;
  updatePlan(id: string, change: PlanChange): Promise<UserPlan>;
};
