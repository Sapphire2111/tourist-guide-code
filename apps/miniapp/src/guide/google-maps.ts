// Загрузчик Google Maps JavaScript API и пул карт (ленивый чанк вместе с PlacesMap).
// Скрипт API — один раз на сессию (loading=async + importLibrary). Каждая new google.maps.Map — платная «загрузка
// карты» (бесплатный объём Dynamic Maps ≈ 10 тыс./мес), поэтому карты не пересоздаются: экран берёт свободную
// из пула и возвращает её при уходе — повторные заходы на экраны с картой новых загрузок не добавляют.
import { DEMO_MAP_ID, mapsApiOnPage, mapsConfig } from "./map-config.js";

export type MapsLibs = {
  core: google.maps.CoreLibrary;
  maps: google.maps.MapsLibrary;
  marker: google.maps.MarkerLibrary;
};

const READY_CALLBACK = "__tgGoogleMapsReady";
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

/** Google отклонил ключ (неверный ключ, referrer, API не включён) — карту не показывать. */
export function mapsAuthFailed(): boolean {
  return authFailed;
}

/** Подписка на отказ ключа (gm_authFailure); уже отказано — вызывается сразу. Возвращает отписку. */
export function onMapsAuthFailure(listener: () => void): () => void {
  if (authFailed) listener();
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

export type PooledMap = { div: HTMLDivElement; map: google.maps.Map; busy: boolean; night: boolean };

const pool: PooledMap[] = [];
let warnedDemo = false;

/**
 * Свободная карта из пула (её узел — в host) или новая. Вид (центр/масштаб) задаёт вызывающий.
 * Тема передаётся аргументом, а не читается из data-theme: атрибут ставит эффект ThemeProvider (родителя) — позже эффектов детей.
 */
export function acquireMap(l: MapsLibs, host: HTMLElement, night: boolean): PooledMap {
  // Схема карты задаётся только при создании: тема «Ніч» — своя карта в пуле (новая загрузка лишь при смене темы).
  let item = pool.find((p) => !p.busy && p.night === night);
  if (!item) {
    if (import.meta.env?.PROD && mapsConfig().mapId === DEMO_MAP_ID && !warnedDemo) {
      warnedDemo = true;
      console.warn(
        "VITE_GOOGLE_MAPS_MAP_ID не задан: DEMO_MAP_ID — только для разработки, задайте свой Map ID.",
      );
    }
    const div = document.createElement("div");
    div.style.width = "100%";
    div.style.height = "100%";
    const map = new l.maps.Map(div, {
      mapId: mapsConfig().mapId,
      center: { lat: 48.45, lng: 24.55 },
      zoom: 12,
      disableDefaultUI: true,
      zoomControl: true,
      clickableIcons: false,
      colorScheme: night ? "DARK" : "LIGHT",
      // Как прежде в Leaflet: один палец двигает карту (экран Mini App, карта — небольшой блок).
      gestureHandling: "greedy",
    });
    item = { div, map, busy: false, night };
    pool.push(item);
  }
  item.busy = true;
  host.appendChild(item.div);
  return item;
}

/** Вернуть карту в пул: узел снимается со страницы, сама карта (и её загрузка) сохраняется. */
export function releaseMap(item: PooledMap): void {
  item.busy = false;
  item.div.remove();
}

/** Только для тестов: сброс пула и загрузчика. */
export function resetMapsForTests(): void {
  pool.length = 0;
  libs = null;
  authFailed = false;
  authListeners.clear();
}
