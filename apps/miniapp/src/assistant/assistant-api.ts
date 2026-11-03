// Ассистент на главной: адаптер POST /assistant/query и /assistant/transcribe поверх @tg/api-client.
// Контекст диалога (прежние реплики и намерение) хранит клиент — сервер ничего не запоминает.
import type { ApiClient, ApiSchemas } from "@tg/api-client";
import { summaryOf } from "../guide/guide-api.js";
import type { LatLng } from "../guide/geo.js";
import { https } from "../guide/guide-api.js";
import type { PlaceSummary } from "../guide/types.js";
import { ok } from "../host/host-api.js";

export type AssistantIntent = ApiSchemas["AssistantIntentDto"];
export type AssistantSuggestion = AssistantIntent["suggestions"][number];
export type AssistantNote = ApiSchemas["AssistantResultDto"]["notes"][number];

export type AssistantItem = {
  place: PlaceSummary;
  priceLevel: number | null;
  kidsFriendly: boolean;
  description: string | null;
  descriptionSource: "ai" | "wikipedia" | "google" | null;
  descriptionUrl: string | null;
};

export type AssistantPlan = ApiSchemas["AssistantPlanDto"];
export type AssistantPlanStop = ApiSchemas["AssistantPlanStopDto"];
export type AssistantDayPart = ApiSchemas["AssistantDayPart"];

export type AssistantResult = {
  intent: AssistantIntent;
  items: AssistantItem[];
  route: { lengthMeters: number } | null;
  /** План отдыха по дням (kind = plan); пункты ссылаются на items по индексу. */
  plan: AssistantPlan | null;
  notes: AssistantNote[];
};

export type AssistantAsk = {
  text: string;
  point?: LatLng | null;
  history: string[];
  previous: AssistantIntent | null;
  /** Выбор «Локація»; пункт, названный в запросе, сервер ставит выше. */
  localityIds?: readonly string[];
};

export type AssistantApi = {
  ask(req: AssistantAsk): Promise<AssistantResult>;
  /** Речь → текст; "" — не распознано. */
  transcribe(audio: Blob): Promise<string>;
};

/** Реплик в контексте — не больше (как ASSISTANT_HISTORY_MAX на сервере). */
export const HISTORY_MAX = 5;
export const TEXT_MAX = 300;

export function resultOf(dto: ApiSchemas["AssistantResultDto"]): AssistantResult {
  return {
    intent: dto.intent,
    items: dto.items.map((i) => ({
      place: summaryOf(i.place),
      priceLevel: i.priceLevel,
      kidsFriendly: i.kidsFriendly,
      description: i.description,
      descriptionSource: i.descriptionSource,
      // Ссылка на статью — только https (в href не попадёт javascript:).
      descriptionUrl: https(i.descriptionUrl),
    })),
    route: dto.route,
    // Старый ответ (или кэш диалога) без плана — null; пункты с индексом вне items отбрасываются.
    plan: dto.plan
      ? {
          ...dto.plan,
          days: dto.plan.days.map((d) => ({
            ...d,
            parts: d.parts.map((p) => ({
              ...p,
              stops: p.stops.filter((s) => s.item >= 0 && s.item < dto.items.length),
            })),
          })),
        }
      : null,
    notes: dto.notes,
  };
}

export function createAssistantApi(api: ApiClient, regionId: string | null): AssistantApi {
  const region = () => {
    if (!regionId) throw new Error("no region");
    return regionId;
  };
  return {
    ask: async ({ text, point, history, previous, localityIds }) =>
      resultOf(
        await ok(
          api.POST("/assistant/query", {
            body: {
              regionId: region(),
              text: text.slice(0, TEXT_MAX),
              ...(point ? { lat: point.lat, lng: point.lng } : {}),
              history: history.slice(-HISTORY_MAX).map((h) => h.slice(0, TEXT_MAX)),
              ...(previous ? { previous } : {}),
              ...(localityIds?.length ? { localityIds: [...localityIds] } : {}),
            },
          }),
        ),
      ),
    transcribe: async (audio) => {
      // Тело — сам файл записи (не JSON): тип — из MediaRecorder без параметров кодека.
      const type = audio.type.split(";")[0]!.trim() || "audio/webm";
      const data = await ok(
        api.POST("/assistant/transcribe", {
          params: { query: { regionId: region() } },
          body: audio as unknown as string,
          bodySerializer: (b: unknown) => b as Blob,
          headers: { "Content-Type": type },
        }),
      );
      return data.text.trim();
    },
  };
}
