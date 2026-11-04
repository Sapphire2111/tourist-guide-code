// Геолокация туриста: LocationManager Telegram (Bot API 8.0+), иначе navigator.geolocation браузера.
// Запрашивается только по нажатию («Що поруч зі мною зараз», «Поділитися геолокацією», пункт «Моє місцезнаходження»),
// не при открытии экрана. Исключение — requestLocationIfGranted: точка берётся без вопроса, только если доступ уже выдан.
import type { TelegramWebApp } from "../telegram.js";

/** accuracy: радиус погрешности устройства, м (если платформа сообщила). */
export type LatLng = { lat: number; lng: number; accuracy?: number };

function withAccuracy(lat: number, lng: number, accuracy: number | null | undefined): LatLng {
  return typeof accuracy === "number" && Number.isFinite(accuracy) && accuracy > 0
    ? { lat, lng, accuracy }
    : { lat, lng };
}

/** Таймаут запроса: без ответа платформы — считаем, что геолокации нет. */
const TIMEOUT_MS = 10_000;

function fromTelegram(webApp: TelegramWebApp): Promise<LatLng | null> | null {
  const lm = webApp.LocationManager;
  const init = lm?.init;
  const getLocation = lm?.getLocation;
  // LocationManager — Bot API 8.0+; на старых клиентах объекта может не быть или он не работает.
  if (!lm || !init || !getLocation) return null;
  if (webApp.isVersionAtLeast && !webApp.isVersionAtLeast("8.0")) return null;
  return new Promise((resolve) => {
    const read = () => {
      if (!lm.isLocationAvailable) return resolve(null);
      getLocation.call(lm, (loc) =>
        resolve(loc ? withAccuracy(loc.latitude, loc.longitude, loc.horizontal_accuracy) : null),
      );
    };
    try {
      // Повторный init() колбэк не вызывает — после инициализации читаем сразу.
      if (lm.isInited) read();
      else init.call(lm, read);
    } catch {
      resolve(null);
    }
  });
}

function fromBrowser(): Promise<LatLng | null> {
  const geo = typeof navigator !== "undefined" ? navigator.geolocation : undefined;
  if (!geo) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      geo.getCurrentPosition(
        (p) => resolve(withAccuracy(p.coords.latitude, p.coords.longitude, p.coords.accuracy)),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: TIMEOUT_MS, maximumAge: 60_000 },
      );
    } catch {
      resolve(null);
    }
  });
}

/** Можно открыть настройки геолокации бота в Telegram (Bot API 8.0+, как и сам LocationManager). */
export function canOpenLocationSettings(webApp?: TelegramWebApp): boolean {
  if (!webApp?.LocationManager?.openSettings) return false;
  return webApp.isVersionAtLeast ? webApp.isVersionAtLeast("8.0") : false;
}

/** Координаты устройства или null (отказ, нет поддержки, таймаут). */
export function requestLocation(webApp?: TelegramWebApp): Promise<LatLng | null> {
  const viaTelegram = webApp ? fromTelegram(webApp) : null;
  const request = viaTelegram ?? fromBrowser();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), TIMEOUT_MS + 1_000);
  });
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}

/** Расстояние по большому кругу, м (для подписи, когда сервер не вернул distance). */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** Ссылка «Маршрут» на OSM (D-06): открывается во внешнем браузере/приложении карт. */
export function routeUrl(to: LatLng, from?: LatLng | null): string {
  const dst = `${to.lat}%2C${to.lng}`;
  // route=<откуда>;<куда>; пустое «откуда» — пользователь выберет старт на сайте/в приложении.
  const src = from ? `${from.lat}%2C${from.lng}` : "";
  return `https://www.openstreetmap.org/directions?route=${src}%3B${dst}`;
}

/**
 * Маршрут в Google Картах из окна маркера: точку старта определяет сам Google (местоположение устройства), способ
 * передвижения выбирает турист. Координаты устройства в ссылку не передаются.
 */
export function googleRouteUrl(to: LatLng, placeId?: string | null): string {
  const base = `https://www.google.com/maps/dir/?api=1&destination=${to.lat},${to.lng}`;
  return placeId ? `${base}&destination_place_id=${encodeURIComponent(placeId)}` : base;
}

/** Доступ к геолокации уже выдан (без диалога разрешения): Telegram LocationManager или Permissions API браузера. */
async function isAccessGranted(webApp?: TelegramWebApp): Promise<boolean> {
  const lm = webApp?.LocationManager;
  if (lm?.init && (!webApp?.isVersionAtLeast || webApp.isVersionAtLeast("8.0"))) {
    const inited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3_000);
      try {
        if (lm.isInited) {
          clearTimeout(timer);
          resolve(true);
        } else
          lm.init?.call(lm, () => {
            clearTimeout(timer);
            resolve(true);
          });
      } catch {
        clearTimeout(timer);
        resolve(false);
      }
    });
    return inited && lm.isLocationAvailable === true && lm.isAccessGranted === true;
  }
  try {
    const state = await navigator.permissions?.query({ name: "geolocation" });
    return state?.state === "granted";
  } catch {
    return false;
  }
}

/** Точка устройства только если доступ уже выдан; иначе null без запроса разрешения (не на старте приложения). */
export async function requestLocationIfGranted(webApp?: TelegramWebApp): Promise<LatLng | null> {
  return (await isAccessGranted(webApp)) ? requestLocation(webApp) : null;
}
