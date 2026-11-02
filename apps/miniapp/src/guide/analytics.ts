// Клиент продуктовой аналитики Mini App (T1-25, ADR-0004): события каталога гида пакетом в POST /analytics/events.
// Без ПДн: только id сущностей и числа (текст поиска не отправляется). Сбой отправки не мешает интерфейсу —
// событие теряется (офлайн-буфер — позже). Без anonymousId (нет контекста входа) события не шлются: схема требует его.
import type { ApiClient } from "@tg/api-client";

type Events = {
  category_opened: { categoryId: string };
  search_used: { categoryId?: string; resultCount?: number };
  place_viewed: { placeId: string };
  route_clicked: { placeId: string };
  call_clicked: { placeId: string };
};
export type GuideEventName = keyof Events;

export type AnalyticsContext = {
  anonymousId?: string | null;
  regionId?: string | null;
  entryContextId?: string | null;
  source: "qr" | "direct";
};

/** UUIDv7 (RFC 9562): 48 бит времени мс + случайные биты; рекомендован для eventId. */
export function uuidv7(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type BatchEvent = Record<string, unknown>;

export type Analytics = {
  track<N extends GuideEventName>(event: N, props: Events[N]): void;
  /** Отправить накопленное сразу (тесты, уход со страницы). */
  flush(): Promise<void>;
};

/** Клиент с пакетированием: события за FLUSH_MS уходят одним запросом. */
export function createAnalytics(
  api: ApiClient,
  getContext: () => AnalyticsContext,
  flushMs = 1_000,
): Analytics {
  // Сессия приложения (sessionId конверта) — одна на открытие Mini App.
  const sessionId = uuidv7();
  const queue: BatchEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const events = queue.splice(0, 50);
    if (!events.length) return;
    try {
      await api.POST("/analytics/events", {
        // Конверт собран по clientAnalyticsEventSchema (@tg/shared); тип union событий тут не воспроизводим.
        body: { events } as never,
        // keepalive — запрос переживает закрытие Mini App (pagehide/visibilitychange).
        keepalive: true,
      });
    } catch {
      // сеть — событие теряется
    }
    if (queue.length) await flush();
  };

  // Mini App сворачивают или закрывают — отправить накопленное, а не терять до таймера.
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => void flush());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void flush();
    });
  }

  return {
    track(event, props) {
      const ctx = getContext();
      if (!ctx.anonymousId) return;
      const placeId = (props as { placeId?: string }).placeId;
      queue.push({
        eventId: uuidv7(),
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        anonymousId: ctx.anonymousId,
        sessionId,
        regionId: ctx.regionId ?? null,
        source: ctx.source,
        entryContextId: ctx.entryContextId ?? null,
        ...(placeId ? { placeId } : {}),
        event,
        props,
      });
      // Маршрут и звонок обычно уводят из приложения — отправляем сразу.
      if (event === "route_clicked" || event === "call_clicked") void flush();
      else if (!timer) timer = setTimeout(() => void flush(), flushMs);
    },
    flush,
  };
}

/** Заглушка без отправки (браузер без контекста, тесты компонентов). */
export const noopAnalytics: Analytics = { track() {}, flush: () => Promise.resolve() };
