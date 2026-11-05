// Загрузчик Google Maps JavaScript API для админки (ленивый чанк вместе с PlaceMap.tsx). Упрощённая копия
// apps/miniapp/src/guide/google-maps.ts: скрипт — один раз на сессию (loading=async + importLibrary). Каждая
// new google.maps.Map — платная «загрузка карты», поэтому карта одна на сессию: панель берёт её и возвращает при
// закрытии, повторные открытия новых загрузок не добавляют.
import { DEMO_MAP_ID, DEFAULT_CENTER, mapsApiOnPage, mapsConfig } from "./map-config.js";

export type MapsLibs = {
  core: google.maps.CoreLibrary;
  maps: google.maps.MapsLibrary;
  marker: google.maps.MarkerLibrary;
};

const READY_CALLBACK = "__tgAdminMapsReady";
/** Неверный ключ или referrer: Google вызывает глобальный gm_authFailure — карта показывает ошибку. */
const authListeners = new Set<() => void>();
let authFailed = false;

let libs: Promise<MapsLibs> | null = null;

/** API и библиотеки maps/marker. Сбой (сеть, нет ключа) — промис сбрасывается: следующий вызов пробует снова. */
export function loadMapsApi(language?: string): Promise<MapsLibs> {
  if (!libs) {
    libs = boot(language).catch((e: unknown) => {
      libs = null;
      throw e;
    });
  }
  return libs;
}

async function boot(language?: string): Promise<MapsLibs> {
  if (!mapsApiOnPage()) await injectScript(language);
  const g = (window as unknown as { google: typeof google }).google.maps;
  const [core, maps, marker] = await Promise.all([
    g.importLibrary("core") as Promise<google.maps.CoreLibrary>,
    g.importLibrary("maps") as Promise<google.maps.MapsLibrary>,
    g.importLibrary("marker") as Promise<google.maps.MarkerLibrary>,
  ]);
  return { core, maps, marker };
}

function injectScript(language?: string): Promise<void> {
  const { key } = mapsConfig();
  if (!key) return Promise.reject(new Error("Google Maps key is not configured"));
  return new Promise<void>((resolve, reject) => {
    const w = window as unknown as Record<string, unknown>;
    w[READY_CALLBACK] = () => {
      delete w[READY_CALLBACK];
      resolve();
    };
    w.gm_authFailure = () => {
      authFailed = true;
      for (const l of authListeners) l();
    };
    const params = new URLSearchParams({ key, v: "weekly", loading: "async", callback: READY_CALLBACK });
    if (language) params.set("language", language);
    params.set("region", "UA");
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.onerror = () => {
      script.remove();
      delete w[READY_CALLBACK];
      reject(new Error("Google Maps script failed to load"));
    };
    document.head.appendChild(script);
  });
}

/** Подписка на отказ ключа (gm_authFailure); уже отказано — вызывается сразу. Возвращает отписку. */
export function onMapsAuthFailure(listener: () => void): () => void {
  if (authFailed) listener();
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

type CachedMap = { div: HTMLDivElement; map: google.maps.Map; busy: boolean };
let cached: CachedMap | null = null;

/** Карта сессии (её узел — в host); занята — новая (не кешируется). Вид (центр/масштаб) задаёт вызывающий. */
export function acquireMap(l: MapsLibs, host: HTMLElement): CachedMap {
  let item = cached && !cached.busy ? cached : null;
  if (!item) {
    const div = document.createElement("div");
    div.style.width = "100%";
    div.style.height = "100%";
    const map = new l.maps.Map(div, {
      mapId: mapsConfig().mapId,
      center: DEFAULT_CENTER,
      zoom: 12,
      clickableIcons: false,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false,
    });
    item = { div, map, busy: false };
    if (!cached) cached = item;
    if (import.meta.env?.PROD && mapsConfig().mapId === DEMO_MAP_ID)
      console.warn("VITE_GOOGLE_MAPS_MAP_ID не задан: DEMO_MAP_ID — только для разработки.");
  }
  item.busy = true;
  host.appendChild(item.div);
  return item;
}

/** Вернуть карту: узел снимается со страницы, сама карта (и её загрузка) сохраняется. */
export function releaseMap(item: CachedMap): void {
  item.busy = false;
  item.div.remove();
}
