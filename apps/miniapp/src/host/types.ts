// Модель блока 5 на стороне Mini App: «Про заклад» (HostModule), сервисные заявки, сценарии и «Мій план».
// Экраны работают с ней, адаптер поверх @tg/api-client — host-api.ts.
import type { LocalizedText } from "@tg/i18n";

export type HostService = {
  id: string;
  title: LocalizedText;
  description: LocalizedText | null;
  /** Целевое время обработки, мин (D-55); null — не задано. */
  slaMinutes: number | null;
};

export type HostModule = {
  placeId: string;
  name: LocalizedText;
  rules: LocalizedText | null;
  wifi: { ssid: string; password: string | null } | null;
  phone: string | null;
  telegram: string | null;
  /** Часы приёма заявок «HH:MM» (местное время отеля); null — круглосуточно. */
  intake: { from: string; to: string } | null;
  /** Сейчас часы приёма. */
  acceptingNow: boolean;
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

/** Номер комнаты: из QR номера или введён гостем (D-49 — помечается). */
export type RoomContext = { value: string; source: "qr" | "guest" };

export type ServiceRequest = {
  id: string;
  placeId: string;
  placeName: LocalizedText | null;
  service: LocalizedText;
  status: RequestStatus;
  comment: string | null;
  room: RoomContext | null;
  createdAt: string;
  /** Принята вне часов приёма — «буде оброблено з …» (HH:MM). */
  deferredUntil: string | null;
  /** Просрочена по SLA (считает сервер). */
  overdue: boolean;
};

export type NewServiceRequest = {
  placeId: string;
  serviceId: string;
  comment: string | null;
  room: RoomContext | null;
  /** EntryContext QR — для room_context из QR номера. */
  entryContextId: string | null;
};

/** Переходы персонала (D-55, S-03 п.7). */
export const STAFF_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  new: ["accepted", "rejected"],
  accepted: ["in_progress", "rejected"],
  in_progress: ["done"],
  done: [],
  rejected: [],
  cancelled_by_guest: [],
};

export type ScenarioSummary = {
  id: string;
  title: LocalizedText;
  description: LocalizedText | null;
  days: number;
};

export type PlanPlace = {
  id: string;
  name: LocalizedText;
  adLabel: "advertising" | "partner" | null;
};

export type PlanItem = {
  id: string;
  /** «HH:MM» или null. */
  time: string | null;
  place: PlanPlace;
  note: LocalizedText | null;
  alternatives: PlanPlace[];
};

export type PlanDay = { day: number; items: PlanItem[] };

export type ScenarioDetail = ScenarioSummary & { schedule: PlanDay[] };

export type UserPlan = {
  id: string;
  scenarioId: string | null;
  title: LocalizedText;
  schedule: PlanDay[];
  updatedAt: string;
};

/** Конфликт (409): недопустимый переход статуса или дубль активной заявки. */
export class ConflictError extends Error {
  constructor(public readonly code: string = "conflict") {
    super("conflict");
  }
}

export type HostApi = {
  hostModule(placeId: string): Promise<HostModule>;
  createRequest(req: NewServiceRequest): Promise<ServiceRequest>;
  myRequests(): Promise<ServiceRequest[]>;
  staffRequests(status: RequestStatus | null): Promise<ServiceRequest[]>;
  setStatus(id: string, status: RequestStatus): Promise<ServiceRequest>;
  scenarios(): Promise<ScenarioSummary[]>;
  scenario(id: string): Promise<ScenarioDetail>;
  plans(): Promise<UserPlan[]>;
  /** Сохранить сценарий (с правками) как план. */
  savePlan(
    scenarioId: string | null,
    title: ScenarioSummary["title"],
    schedule: PlanDay[],
  ): Promise<UserPlan>;
  updatePlan(id: string, schedule: PlanDay[]): Promise<UserPlan>;
};
