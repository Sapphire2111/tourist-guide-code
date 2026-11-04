// Единый источник правды для «Назад» Mini App (BackButton Telegram и своя кнопка экрана).
// Каждая запись истории получает метку в history.state: номер от входа в приложение и ключ. По ним ясно, есть ли
// куда вернуться внутри приложения: да — history.back(), нет (вход по прямой ссылке или QR) — логичный родитель
// заменой, без выхода из Mini App. По ключу записи живут прокрутка и состояние экрана (screen-state.ts): фильтры,
// запрос, радиус — поэтому возврат показывает экран таким, каким его оставили, а новый заход — чистым.
import { pathFromHash } from "@tg/ui";
import { consumeBack } from "./telegram.js";

const STATE_KEY = "tgNav";
const STORE_KEY = "tg.nav.v1";
/** Сколько последних записей хранить в sessionStorage (перезагрузка страницы при устаревшем чанке). */
const PERSIST_MAX = 30;
/** Сколько последних записей держат в памяти данные списков (страницы мест). */
const MEMO_MAX = 10;
/** Срок жизни данных списка: старше — при возврате показываются сразу и обновляются в фоне («Відкрито», цены). */
export const MEMO_TTL_MS = 5 * 60_000;

type Entry = {
  key: string;
  hash: string;
  scroll: number;
  slots: Record<string, unknown>;
  /** Ссылка приложения, по которой ушли с экрана: при возврате фокус — на неё. */
  focusHref?: string;
};
type Stamp = { idx: number; key: string };
type Memo = { key: string; data: unknown; at: number };

let stack: (Entry | null)[] = [];
let index = -1;
let counter = 0;
/** Нижняя запись, до которой реально можно дойти назад: браузер отбрасывает старые (в Chromium — сверх 50). */
let floor = 0;
/** Ссылка, на которую вернуть фокус после возврата на экран. */
let pendingFocus: string | undefined;
/** Значения вне sessionStorage: координаты устройства, данные списков. */
const volatile = new Map<string, Map<string, unknown>>();
const memos = new Map<string, Map<string, Memo>>();

function newKey(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
}

/** `#tgWebAppData=…` и пустой адрес — главная; остальное как есть (кодировка — как у location.hash). */
export function normalizeHash(hash: string): string {
  return hash.startsWith("#/") ? hash : "#/";
}

function stampOf(state: unknown): Stamp | null {
  const raw = (state as Record<string, unknown> | null)?.[STATE_KEY] as Partial<Stamp> | undefined;
  return raw && typeof raw.idx === "number" && typeof raw.key === "string"
    ? { idx: raw.idx, key: raw.key }
    : null;
}

function writeStamp(entry: Entry, idx: number): void {
  const state = (window.history.state ?? {}) as Record<string, unknown>;
  window.history.replaceState(
    { ...state, [STATE_KEY]: { idx, key: entry.key } satisfies Stamp },
    "",
    window.location.href,
  );
}

function dropEntry(key: string): void {
  volatile.delete(key);
  memos.delete(key);
}

// --- хранилище ---

let persistTimer: ReturnType<typeof setTimeout> | undefined;

function persistNow(): void {
  clearTimeout(persistTimer);
  persistTimer = undefined;
  try {
    const from = Math.max(0, stack.length - PERSIST_MAX);
    sessionStorage.setItem(STORE_KEY, JSON.stringify(stack.map((e, i) => (i < from ? null : e))));
  } catch {
    // Нет хранилища или переполнено — состояние живёт только в памяти.
  }
}

function persist(): void {
  if (persistTimer === undefined) persistTimer = setTimeout(persistNow, 0);
}

function loadStack(): (Entry | null)[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? (raw as (Entry | null)[]) : [];
  } catch {
    return [];
  }
}

// --- прокрутка ---

/** Сколько ждать появления содержимого (данные с холодного сервера), мс. */
const RESTORE_DEADLINE_MS = 6000;
/** Сколько удерживать позицию после её достижения (догрузка фото и карты), мс. */
const RESTORE_HOLD_MS = 500;

let stopRestore: (() => void) | null = null;

function scrollInstant(top: number): void {
  window.scrollTo({ top, behavior: "instant" as ScrollBehavior });
}

function recordScroll(): void {
  if (stopRestore) return;
  const entry = stack[index];
  if (entry) entry.scroll = Math.max(0, Math.round(window.scrollY));
}

function scrollTop(): void {
  stopRestore?.();
  if (window.scrollY !== 0) scrollInstant(0);
}

/** Вернуть прокрутку, как только страница дорастёт до неё; жест пользователя прекращает попытки. */
function restoreScroll(target: number): void {
  stopRestore?.();
  if (target <= 0) {
    if (window.scrollY !== 0) scrollInstant(0);
    return;
  }
  const schedule = (cb: () => void) =>
    window.requestAnimationFrame ? window.requestAnimationFrame(cb) : window.setTimeout(cb, 16);
  const started = Date.now();
  let reachedAt = 0;
  let stopped = false;
  const gestures = ["touchstart", "wheel", "keydown", "pointerdown"] as const;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopRestore = null;
    gestures.forEach((g) => window.removeEventListener(g, stop));
  };
  stopRestore = stop;
  gestures.forEach((g) => window.addEventListener(g, stop, { passive: true }));
  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    if (Math.abs(window.scrollY - target) > 1) {
      scrollInstant(target);
      if (Math.abs(window.scrollY - target) > 1) reachedAt = 0;
    }
    if (Math.abs(window.scrollY - target) <= 1 && !reachedAt) reachedAt = now;
    if ((reachedAt && now - reachedAt >= RESTORE_HOLD_MS) || now - started >= RESTORE_DEADLINE_MS) {
      stop();
      recordScroll();
      return;
    }
    schedule(tick);
  };
  schedule(tick);
}

// --- учёт записей ---

/** Привести учёт к текущей записи истории; идемпотентно, вызывается и событиями, и при чтении ключа в рендере. */
function sync(): Entry {
  install();
  const stamp = stampOf(window.history.state);
  const hash = normalizeHash(window.location.hash);
  if (!stamp) {
    backSettled();
    pendingFocus = undefined;
    const first = index < 0;
    if (first) stack = [];
    const idx = first ? 0 : index + 1;
    stack.slice(idx).forEach((e) => e && dropEntry(e.key));
    const entry: Entry = { key: newKey(), hash, scroll: 0, slots: {} };
    stack.length = idx;
    stack[idx] = entry;
    index = idx;
    writeStamp(entry, idx);
    stack.slice(0, Math.max(0, idx + 1 - MEMO_MAX)).forEach((e) => e && memos.delete(e.key));
    if (!first) scrollTop();
    persist();
    return entry;
  }
  const current = stack[index];
  if (current?.key === stamp.key && index === stamp.idx) {
    if (current.hash !== hash) {
      // Замена записи (navigate с replace): другой экран — сверху; тот же экран (снят ?q=) — на месте.
      const samePath = pathFromHash(current.hash) === pathFromHash(hash);
      current.hash = hash;
      if (!samePath) {
        current.scroll = 0;
        scrollTop();
      }
      persist();
    }
    return current;
  }
  // Возврат или шаг вперёд; при первом вызове — перезагрузка страницы посреди истории.
  backSettled();
  if (index < 0) stack = loadStack();
  let entry = stack[stamp.idx];
  if (entry?.key !== stamp.key) {
    entry = { key: stamp.key, hash, scroll: 0, slots: {} };
    stack[stamp.idx] = entry;
  }
  entry.hash = hash;
  index = stamp.idx;
  pendingFocus = entry.focusHref;
  restoreScroll(entry.scroll);
  return entry;
}

/** Обычный клик по ссылке приложения: без записи на тот же адрес, и шаг назад вместо A→B→A→B. */
function onDocumentClick(e: MouseEvent): void {
  recordScroll();
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest?.("a[href^='#/']");
  if (!(a instanceof HTMLAnchorElement) || a.target === "_blank") return;
  const from = sync();
  const target = normalizeHash(new URL(a.href).hash);
  if (target === normalizeHash(window.location.hash)) {
    e.preventDefault();
    return;
  }
  from.focusHref = a.getAttribute("href") ?? undefined;
  // Двойной тап: возврат по первому ещё не случился — второй не уводит на шаг дальше.
  if (backPending()) {
    e.preventDefault();
    return;
  }
  if (index > floor && stack[index - 1]?.hash === target) {
    e.preventDefault();
    // Запись отброшена браузером — обычный переход по ссылке.
    stepBack(Date.now, () => {
      window.location.hash = target;
    });
  }
}

let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  try {
    // Прокруткой при возврате управляет restoreScroll: браузер не дождался бы загрузки данных.
    window.history.scrollRestoration = "manual";
  } catch {
    // Старый WebView без scrollRestoration — восстановление всё равно сработает поверх.
  }
  window.addEventListener("hashchange", () => void sync());
  window.addEventListener("popstate", () => void sync());
  window.addEventListener("scroll", recordScroll, { passive: true });
  window.addEventListener("pagehide", persistNow);
  document.addEventListener("click", onDocumentClick);
}

/** Подключить учёт до первого рендера; адрес входа становится записью номер 0. */
export function initNavigation(): void {
  sync();
}

// --- состояние экрана ---

/** Ключ текущей записи истории: экран привязывает к нему своё состояние при монтировании. */
export function currentEntryKey(): string {
  return sync().key;
}

function findEntry(key: string): Entry | undefined {
  return stack.find((e) => e?.key === key) ?? undefined;
}

export function readSlot(key: string, slot: string, inMemoryOnly = false): unknown {
  if (inMemoryOnly) return volatile.get(key)?.get(slot);
  return findEntry(key)?.slots[slot];
}

export function writeSlot(key: string, slot: string, value: unknown, inMemoryOnly = false): void {
  if (inMemoryOnly) {
    if (!findEntry(key)) return;
    const slots = volatile.get(key) ?? new Map<string, unknown>();
    slots.set(slot, value);
    volatile.set(key, slots);
    return;
  }
  const entry = findEntry(key);
  if (!entry) return;
  entry.slots[slot] = value;
  persist();
}

export function deleteSlot(key: string, slot: string, inMemoryOnly = false): void {
  if (inMemoryOnly) {
    volatile.get(key)?.delete(slot);
    return;
  }
  const entry = findEntry(key);
  if (entry) delete entry.slots[slot];
  persist();
}

/** Данные списка записи (только память): возврат показывает их сразу; `stale` — пора обновить в фоне. */
export function readMemo<T>(
  key: string,
  slot: string,
  depsKey: string,
  now: number = Date.now(),
): { data: T; stale: boolean } | undefined {
  const memo = memos.get(key)?.get(slot);
  return memo && memo.key === depsKey
    ? { data: memo.data as T, stale: now - memo.at >= MEMO_TTL_MS }
    : undefined;
}

export function writeMemo(key: string, slot: string, depsKey: string, data: unknown): void {
  if (!findEntry(key)) return;
  const slots = memos.get(key) ?? new Map<string, Memo>();
  slots.set(slot, { key: depsKey, data, at: Date.now() });
  memos.set(key, slots);
}

export function deleteMemo(key: string, slot: string): void {
  memos.get(key)?.delete(slot);
}

// --- «Назад» ---

/** Куда вести «Назад», когда истории в приложении нет. Цепочка всегда заканчивается главной: циклов нет. */
export function parentOf(path: string): string {
  const book = /^\/book\/([^/]+)$/.exec(path);
  if (book) return `/place/${book[1]}`;
  if (/^\/plan\/saved\/./.test(path)) return "/plan/saved";
  if (/^\/plan\/./.test(path)) return "/plan";
  if (/^\/partner\/./.test(path)) return "/partner";
  return "/";
}

/** Повторное нажатие, пока возврат по истории не случился (адрес тот же), — не уводит на шаг дальше (из Mini App). */
const GUARD_MS = 1000;
/** Сколько ждать возврата: браузер отбросил запись — history.back() молчит, кнопка не должна быть мёртвой. */
export const BACK_TIMEOUT_MS = 500;
let backingUntil = 0;
let backingFrom: string | null = null;
let backTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Запись сменилась — возврат состоялся. Быстрый новый заход на тот же адрес не примется ни за «history.back() молчит»,
 * ни за повторное нажатие.
 */
function backSettled(): void {
  clearTimeout(backTimer);
  backingUntil = 0;
  backingFrom = null;
}

function backPending(now: () => number = Date.now): boolean {
  return now() < backingUntil && window.location.hash === backingFrom;
}

/** history.back() с защитой от повтора; адрес не сменился за BACK_TIMEOUT_MS — ниже записей нет, `onStuck`. */
function stepBack(now: () => number, onStuck: () => void): void {
  recordScroll();
  const from = window.location.hash;
  const fromIndex = index;
  backingUntil = now() + GUARD_MS;
  backingFrom = from;
  clearTimeout(backTimer);
  backTimer = setTimeout(() => {
    sync();
    if (window.location.hash !== from || index !== fromIndex) return;
    floor = index;
    backingUntil = 0;
    onStuck();
  }, BACK_TIMEOUT_MS);
  window.history.back();
}

export function goBack(
  navigate: (to: string, opts?: { replace?: boolean }) => void,
  now: () => number = Date.now,
): void {
  sync();
  if (backPending(now)) return;
  const toParent = () => navigate(parentOf(pathFromHash(window.location.hash)), { replace: true });
  if (index > floor && window.history.length > 1) {
    stepBack(now, toParent);
    return;
  }
  toParent();
}

/** Ссылка, с которой ушли с экрана, если на него вернулись (один раз). */
export function takeReturnFocus(): string | undefined {
  const href = pendingFocus;
  pendingFocus = undefined;
  return href;
}

/** Фокус на заголовок экрана без прокрутки; false — заголовка ещё нет. */
export function focusScreenHeading(): boolean {
  const h1 = document.querySelector<HTMLElement>("main h1") ?? document.querySelector<HTMLElement>("h1");
  if (!h1) return false;
  if (!h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
  h1.focus({ preventScroll: true });
  return true;
}

/** Запрос на удаление данных: состояние экранов, запросы в адресах прежних записей и данные списков стираются. */
export function clearNavigationData(): void {
  clearTimeout(persistTimer);
  persistTimer = undefined;
  stack.forEach((e, i) => {
    if (!e) return;
    e.slots = {};
    delete e.focusHref;
    if (i !== index) e.hash = "";
  });
  volatile.clear();
  memos.clear();
  try {
    sessionStorage.removeItem(STORE_KEY);
  } catch {
    // нет хранилища — нечего очищать
  }
}

/** Нажатие «Назад»: сначала слой поверх экрана (лист, фото, шаг формы), затем переход. */
export function pressBack(navigate: (to: string, opts?: { replace?: boolean }) => void): void {
  if (!consumeBack()) goBack(navigate);
}

/** Для тестов: как новый вход в приложение. Текущая запись станет номером 0. */
export function resetNavigation(): void {
  stopRestore?.();
  clearTimeout(persistTimer);
  persistTimer = undefined;
  clearTimeout(backTimer);
  stack = [];
  index = -1;
  floor = 0;
  pendingFocus = undefined;
  volatile.clear();
  memos.clear();
  backingUntil = 0;
  backingFrom = null;
  try {
    sessionStorage.removeItem(STORE_KEY);
  } catch {
    // нет хранилища
  }
  window.history.replaceState(null, "");
}
