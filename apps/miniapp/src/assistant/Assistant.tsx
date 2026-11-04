// Экран ассистента: диалог «реплика → места каталога». Места, цены и описания — только из ответа api (каталог и
// обогащение); модель на сервере выбирает лишь категории и фильтры. Уточнения — следующей репликой или чипом;
// контекст диалога (прежние реплики и намерение) хранится здесь и отправляется с каждым запросом.
import { SHOW_AI_LABELS } from "../ai-labels.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Link, Stack, useFeatureFlag, useRoute, useT } from "@tg/ui";
import { useCategoryIndex, type CategoryIndex } from "../guide/categories.js";
import { useGuide } from "../guide/context.js";
import { distanceMeters, type LatLng } from "../guide/geo.js";
import { LOCATION_MAX, useLocationNames, useLocations } from "../guide/LocationProvider.js";
import { MapSlot, preloadMap } from "../guide/MapSlot.js";
import { useRadiusLabel } from "../guide/Nearby.js";
import { PlaceSummaryCard } from "../guide/parts.js";
import type { LocalityOption } from "../guide/types.js";
import { useOptionalHost } from "../host/context.js";
import { useErrorText } from "../host/errors.js";
import { markPlanPartial } from "../plan/partial-notice.js";
import { useBackStep } from "../screen-state.js";
import type {
  AssistantApi,
  AssistantIntent,
  AssistantItem,
  AssistantPlan,
  AssistantPlanScope,
  AssistantPlanStop,
  AssistantPlanTransport,
  AssistantQuestion,
  AssistantResult,
} from "./assistant-api.js";
import { AssistantBox } from "./AssistantBox.js";
import { AssistantSessionProvider, useAssistantSession, useOptionalAssistantSession } from "./session.js";

export { DIALOG_KEY } from "./dialog-store.js";

/** Что ищем — по намерению: категории (названия из справочника), фильтры. */
export function useIntentSummary(index: CategoryIndex): (intent: AssistantIntent) => string {
  const { t, locale } = useT();
  const radius = useRadiusLabel();
  return (intent) => {
    const byCode = new Map(index.list.filter((c) => c.code).map((c) => [c.code!, c]));
    const parts = intent.categories.map((code) => {
      const c = byCode.get(code);
      return c ? pickLocalized(c.name, locale) : code;
    });
    // Блюдо или кухня — первое слово модели («суші»).
    const keyword = intent.keywords?.[0];
    if (keyword) parts.unshift(t("miniapp.assistant.filter.keyword", { q: keyword }));
    if (!parts.length && intent.nameQuery)
      parts.push(t("miniapp.assistant.anything", { q: intent.nameQuery }));
    if (intent.kind === "tour") parts.push(t("miniapp.assistant.filter.tour"));
    if (intent.kind === "plan") parts.unshift(t("miniapp.assistant.filter.plan"));
    // Названный пункт ищется по пункту, без радиуса — радиус не обещаем.
    if (intent.radiusMeters && !intent.locality)
      parts.push(t("miniapp.assistant.filter.radius", { r: radius(intent.radiusMeters) }));
    if (intent.priceMax !== null && intent.priceMax <= 2) parts.push(t("miniapp.assistant.filter.cheap"));
    if (intent.priceMin !== null && intent.priceMin >= 3) parts.push(t("miniapp.assistant.filter.pricey"));
    if (intent.withKids) parts.push(t("miniapp.assistant.filter.kids"));
    if (intent.openNow) parts.push(t("miniapp.assistant.filter.open"));
    return t("miniapp.assistant.searching", { what: parts.join(", ") });
  };
}

/** Экран ассистента; вне провайдера выше маршрутов (тесты экрана) — со своим провайдером. */
export function Assistant(props: { api: AssistantApi; initialQuery?: string }) {
  const session = useOptionalAssistantSession();
  if (session) return <AssistantScreen {...props} />;
  return (
    <AssistantSessionProvider>
      <AssistantScreen {...props} />
    </AssistantSessionProvider>
  );
}

function AssistantScreen({ api, initialQuery = "" }: { api: AssistantApi; initialQuery?: string }) {
  const { t, locale } = useT();
  const guide = useGuide();
  const index = useCategoryIndex(guide.api);
  const summary = useIntentSummary(index);
  const errorText = useErrorText();
  const [, navigate] = useRoute();
  const { session, ask: askSession, reset, setUi } = useAssistantSession();
  const turns = session.turns;
  const { selected: localityIds, gps } = useLocations();
  const point = gps ?? guide.base?.point ?? null;

  const ask = (text: string, previousOverride?: AssistantIntent, answer = false) => {
    // Контекст — завершённые реплики этого диалога и намерение последнего ответа (с ответами на уточнения).
    const done = turns.filter((x) => x.state.status === "ready");
    const lastReady = done[done.length - 1];
    const previous =
      previousOverride ?? (lastReady?.state.status === "ready" ? lastReady.state.data.intent : null);
    askSession(api, {
      text,
      point,
      previous,
      ...(localityIds.length ? { localityIds } : {}),
      // Ответ на уточнения — структурой в previous, без повторного разбора моделью.
      ...(answer ? { answer: true } : {}),
    });
  };

  // Запрос с главной (#/assistant?q=…) — новый диалог и сразу первая реплика.
  const started = useRef(false);
  useEffect(() => {
    preloadMap(locale).catch(() => undefined);
    if (started.current || !initialQuery.trim()) return;
    started.current = true;
    reset();
    askSession(api, {
      text: initialQuery.trim(),
      point,
      previous: null,
      ...(localityIds.length ? { localityIds } : {}),
    });
    // Адрес без запроса: «Назад» из карточки места вернёт диалог, а не повторит запрос.
    navigate("/assistant", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const last = turns[turns.length - 1];
  const busy = last?.state.status === "loading";
  const result = last?.state.status === "ready" ? last.state.data : null;
  const ui = last && session.ui?.turn === last.id ? session.ui : null;
  // Ответ уже был при открытии экрана (возврат из карточки места) — прокрутка как была; новый запрос — сверху.
  const returning = useRef(Boolean(result) && !initialQuery.trim());
  useScrollMemory(Boolean(result), returning.current ? (ui?.scrollY ?? 0) : 0, setUi);
  const questions = result?.questions ?? [];

  return (
    // Переход из ответа в экран приложения (карточка места): прокрутка — сейчас, до смены экрана
    // (сохранение по прокрутке отложено и может не успеть). «Назад» идёт по истории (back.ts).
    <div
      className="assistant-screen"
      onClickCapture={(e) => {
        if ((e.target as Element | null)?.closest?.("a[href^='#/']"))
          setUi({ scrollY: Math.max(0, Math.round(window.scrollY)) });
      }}
    >
      <Stack>
        <h1>{t("miniapp.assistant.title")}</h1>
        <p className="kosiv-muted">{t("miniapp.assistant.hint")}</p>
        {turns.length > 0 && (
          <ol
            className="assistant-dialog"
            aria-label={t("miniapp.assistant.dialog")}
            data-testid="assistant-dialog"
          >
            {turns.map((turn) => (
              <li key={turn.id}>
                <p className="assistant-you">
                  <strong>{t("miniapp.assistant.you")}:</strong> {turn.text}
                </p>
                <p
                  className="assistant-reply"
                  role={turn.state.status === "error" ? "alert" : undefined}
                  data-testid="assistant-reply"
                >
                  {turn.state.status === "loading"
                    ? t("miniapp.assistant.thinking")
                    : turn.state.status === "error"
                      ? errorText(turn.state.error, "miniapp.assistant.error")
                      : turn.state.data.intent.clarify
                        ? t("miniapp.assistant.clarify")
                        : summary(turn.state.data.intent)}
                </p>
              </li>
            ))}
          </ol>
        )}
        {/* Ответ на последнюю реплику: количество объявляется читалкой. */}
        <p role="status" className="kosiv-muted" data-testid="assistant-status">
          {busy
            ? t("miniapp.assistant.thinking")
            : result && questions.length
              ? t("miniapp.assistant.question.status")
              : result && !result.intent.clarify
                ? result.items.length
                  ? t("miniapp.assistant.found", { n: result.items.length })
                  : t("miniapp.assistant.empty")
                : ""}
        </p>
        {result && questions.length > 0 && (
          <PlanQuestions
            key={`q${last!.id}`}
            intent={result.intent}
            questions={questions}
            busy={busy}
            onAnswer={(text, previous) => ask(text, previous, true)}
          />
        )}
        {/* key — новый ответ начинает список и дни плана сначала; состояние экрана — из провайдера. */}
        {result && (
          <ResultView
            key={`r${last!.id}`}
            result={result}
            shown={ui?.shown || PAGE_SIZE}
            onShown={(shown) => setUi({ shown })}
            dayIndex={ui?.dayIndex ?? 0}
            onDay={(dayIndex) => setUi({ dayIndex })}
          />
        )}
        {result && questions.length === 0 && result.intent.suggestions.length > 0 && (
          <div
            role="group"
            aria-label={t("miniapp.assistant.chips")}
            className="kosiv-tags"
            data-testid="assistant-chips"
          >
            {result.intent.suggestions.map((s) => {
              const label = t(`miniapp.assistant.chip.${s}` as MessageKey);
              return (
                <button
                  key={s}
                  type="button"
                  className="kosiv-tag"
                  disabled={busy}
                  onClick={() => ask(label)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        {turns.length > 0 && (
          <Button onClick={reset} disabled={busy}>
            {t("miniapp.assistant.newDialog")}
          </Button>
        )}
        {/* Одна строка ввода: пустой диалог — начальный запрос; есть ответы — уточнения, закреплена внизу. */}
        <div className={turns.length ? "assistant-dock" : undefined}>
          <AssistantBox
            api={api}
            onSubmit={(text) => ask(text)}
            busy={busy}
            id="assistant-next"
            variant={turns.length ? "refine" : "start"}
            autoFocus={!initialQuery && !turns.length}
          />
        </div>
      </Stack>
    </div>
  );
}

/**
 * Прокрутка экрана ответа: запоминается (в провайдере и хранилище) при прокрутке; при возврате на экран (диалог
 * восстановлен) — восстанавливается после отрисовки ответа (и ещё раз, когда догрузились карта и фото).
 */
function useScrollMemory(ready: boolean, restoreTo: number, setUi: (patch: { scrollY: number }) => void) {
  const restored = useRef(false);
  useEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    if (restoreTo <= 0) return;
    const go = () => window.scrollTo({ top: restoreTo, behavior: "instant" as ScrollBehavior });
    const raf = window.requestAnimationFrame(go);
    const late = window.setTimeout(go, 350);
    // Медленное устройство: ещё раз, если турист сам ещё не прокрутил (страница всё ещё вверху).
    const later = window.setTimeout(() => {
      if (window.scrollY < restoreTo / 2) go();
    }, 900);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(late);
      window.clearTimeout(later);
    };
  }, [ready, restoreTo]);
  useEffect(() => {
    let id: number | undefined;
    const onScroll = () => {
      window.clearTimeout(id);
      id = window.setTimeout(() => setUi({ scrollY: Math.max(0, Math.round(window.scrollY)) }), 150);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.clearTimeout(id);
    };
  }, [setUi]);
}

/**
 * Уточнения перед многодневным планом: «Де плануєте відпочивати?» (тільки тут, по всьому регіону, обрані
 * локації — мультивыбор пунктов) и «Як пересуваєтесь?» (на авто, пішки). Когда отвечено на всё — следующая реплика
 * с ответами в previous (scope, scopeLocalityIds, transport).
 */
function PlanQuestions({
  intent,
  questions,
  busy,
  onAnswer,
}: {
  intent: AssistantIntent;
  questions: readonly AssistantQuestion[];
  busy: boolean;
  onAnswer: (text: string, previous: AssistantIntent) => void;
}) {
  const { t, locale } = useT();
  const { base } = useGuide();
  const { options, selected, gps } = useLocations();
  const selectedNames = useLocationNames();
  const point = gps ?? base?.point ?? null;
  const askScope = questions.includes("scope");
  const askTransport = questions.includes("transport");
  const [scope, setScope] = useState<{ scope: AssistantPlanScope; ids: string[]; label: string } | null>(
    null,
  );
  const [transport, setTransport] = useState<{ transport: AssistantPlanTransport; label: string } | null>(
    null,
  );
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  // «Тільки тут»: выбор «Локація» — его пункты; иначе ближайший пункт к точке, название жилья или «поточна точка».
  const near = point && options ? nearestOption(options, point) : null;
  const hereName = selectedNames.length
    ? selectedNames.join(", ")
    : near
      ? pickLocalized(near.name, locale)
      : (base?.name ?? t("miniapp.assistant.scope.herePoint"));
  const canHere = selected.length > 0 || point !== null;
  const pickable = (options ?? []).filter((o) => o.id);

  const finish = (s: typeof scope | null = scope, tr: typeof transport | null = transport) => {
    if ((askScope && !s) || (askTransport && !tr)) return;
    const text = [s?.label, tr?.label].filter(Boolean).join(", ");
    onAnswer(text, {
      ...intent,
      ...(s ? { scope: s.scope, scopeLocalityIds: s.ids } : {}),
      ...(tr ? { transport: tr.transport } : {}),
    });
  };
  const chooseScope = (v: NonNullable<typeof scope>) => {
    setScope(v);
    setPicking(false);
    finish(v, transport);
  };
  const chooseTransport = (v: NonNullable<typeof transport>) => {
    setTransport(v);
    finish(scope, v);
  };

  return (
    <section className="assistant-questions" data-testid="assistant-questions">
      {askScope && (
        <div role="group" aria-labelledby="assistant-q-scope" className="assistant-question">
          <h2 id="assistant-q-scope" aria-live="polite">
            {t("miniapp.assistant.question.scope")}
          </h2>
          <div className="kosiv-tags">
            {canHere && (
              <button
                type="button"
                className="kosiv-tag"
                aria-pressed={scope?.scope === "here"}
                disabled={busy}
                onClick={() =>
                  chooseScope({
                    scope: "here",
                    ids: [],
                    label: t("miniapp.assistant.scope.here", { name: hereName }),
                  })
                }
              >
                {t("miniapp.assistant.scope.here", { name: hereName })}
              </button>
            )}
            <button
              type="button"
              className="kosiv-tag"
              aria-pressed={scope?.scope === "region"}
              disabled={busy}
              onClick={() =>
                chooseScope({ scope: "region", ids: [], label: t("miniapp.assistant.scope.region") })
              }
            >
              {t("miniapp.assistant.scope.region")}
            </button>
            {pickable.length >= 2 && (
              <button
                type="button"
                className="kosiv-tag"
                aria-expanded={picking}
                aria-pressed={scope?.scope === "localities"}
                disabled={busy}
                onClick={() => setPicking((v) => !v)}
              >
                {t("miniapp.assistant.scope.pick")}
              </button>
            )}
          </div>
          {picking && (
            <div className="assistant-pick" data-testid="assistant-scope-pick">
              <div className="kosiv-tags" role="group" aria-label={t("miniapp.assistant.scope.pick")}>
                {pickable.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className="kosiv-tag"
                    aria-pressed={picked.includes(o.id)}
                    onClick={() =>
                      setPicked((p) =>
                        p.includes(o.id) ? p.filter((x) => x !== o.id) : [...p, o.id].slice(0, LOCATION_MAX),
                      )
                    }
                  >
                    {pickLocalized(o.name, locale)}
                  </button>
                ))}
              </div>
              <Button
                disabled={!picked.length || busy}
                onClick={() => {
                  const names = pickable
                    .filter((o) => picked.includes(o.id))
                    .map((o) => pickLocalized(o.name, locale));
                  chooseScope({
                    scope: "localities",
                    ids: picked,
                    label: t("miniapp.assistant.scope.picked", { names: names.join(", ") }),
                  });
                }}
              >
                {t("miniapp.assistant.scope.pickDone")}
              </Button>
            </div>
          )}
        </div>
      )}
      {askTransport && (
        <div role="group" aria-labelledby="assistant-q-transport" className="assistant-question">
          <h2 id="assistant-q-transport" aria-live="polite">
            {t("miniapp.assistant.question.transport")}
          </h2>
          <div className="kosiv-tags">
            {(["car", "foot"] as const).map((v) => {
              const label = t(`miniapp.assistant.transport.${v}` as MessageKey);
              return (
                <button
                  key={v}
                  type="button"
                  className="kosiv-tag"
                  aria-pressed={transport?.transport === v}
                  disabled={busy}
                  onClick={() => chooseTransport({ transport: v, label })}
                >
                  <span aria-hidden="true">{v === "car" ? "🚗" : "🚶"}</span> {label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

/** Ближайший к точке пункт (не дальше NEAR_LOCALITY_M) — подпись «Тільки тут (Яремче)». */
const NEAR_LOCALITY_M = 10_000;
function nearestOption(options: readonly LocalityOption[], point: LatLng): LocalityOption | null {
  let best: LocalityOption | null = null;
  let bestD = NEAR_LOCALITY_M;
  for (const o of options) {
    if (!o.location) continue;
    const d = distanceMeters(point, o.location);
    if (d <= bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/** Мест в списке сразу и за нажатие «Показати ще». */
export const PAGE_SIZE = 10;

function ResultView({
  result,
  shown,
  onShown,
  dayIndex,
  onDay,
}: {
  result: AssistantResult;
  /** Сколько мест раскрыто («Показати ще») — из провайдера (переживает «Назад» из карточки). */
  shown: number;
  onShown: (n: number) => void;
  dayIndex: number;
  onDay: (i: number) => void;
}) {
  const { t } = useT();
  const { base } = useGuide();
  const distance = useRadiusLabel();
  const setShown = (f: (n: number) => number) => onShown(f(shown));
  // Тот же массив между рендерами — карта не перестраивает маркеры при каждом рендере экрана.
  const places = useMemo(() => result.items.map((i) => i.place), [result]);
  if (result.intent.clarify || !result.items.length) return null;
  const notes = result.notes.map((n) => (
    <p key={n} className="kosiv-muted" data-testid="assistant-note">
      {t(`miniapp.assistant.note.${n}` as MessageKey)}
    </p>
  ));
  // Ответ из sessionStorage до появления плана — без поля plan.
  const plan = result.plan ?? null;
  if (plan && plan.days.length)
    return (
      <Stack>
        {notes}
        <PlanView plan={plan} result={result} dayIndex={dayIndex} onDay={onDay} />
      </Stack>
    );
  const tour = result.intent.kind === "tour";
  // Экскурсия — все остановки (маршрут); список мест — по PAGE_SIZE, дальше «Показати ще».
  const visible = tour ? result.items : result.items.slice(0, shown);
  return (
    <Stack>
      {notes}
      {tour && (
        <p data-testid="assistant-route">
          {result.route
            ? t("miniapp.assistant.tour", { n: places.length, len: distance(result.route.lengthMeters) })
            : t("miniapp.assistant.tourNoLine", { n: places.length })}
        </p>
      )}
      <MapSlot places={places} center={base?.point ?? null} centerLabel={base?.name} route={tour} />
      <ol className="assistant-list" data-testid="assistant-places">
        {visible.map((item, i) => (
          <AssistantPlace key={item.place.id} item={item} stop={tour ? i + 1 : null} />
        ))}
      </ol>
      {visible.length < result.items.length && (
        <Button onClick={() => setShown((n) => n + PAGE_SIZE)} data-testid="assistant-more">
          {t("miniapp.assistant.more")}
        </Button>
      )}
    </Stack>
  );
}

/** Время на месте: «≈ 45 хв», «≈ 2 год», «≈ 1 год 30 хв». */
function useDuration(): (minutes: number) => string {
  const { t } = useT();
  return (minutes) => {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (!h) return t("miniapp.assistant.plan.minutes", { m });
    return m ? t("miniapp.assistant.plan.hoursMinutes", { h, m }) : t("miniapp.assistant.plan.hours", { h });
  };
}

/**
 * План отдыха: дни (вкладки, если их несколько), части дня, пункты с временем, ролью, переездом, часами работы и
 * пояснением; карта — места выбранного дня с маршрутом в порядке плана.
 */
function PlanView({
  plan,
  result,
  dayIndex,
  onDay: setDayIndex,
}: {
  plan: AssistantPlan;
  result: AssistantResult;
  dayIndex: number;
  onDay: (i: number) => void;
}) {
  const { t, locale } = useT();
  const { base } = useGuide();
  const distance = useRadiusLabel();
  const day = plan.days[Math.min(dayIndex, plan.days.length - 1)]!;
  const foot = result.intent.transport === "foot";
  const places = useMemo(
    () => day.parts.flatMap((p) => p.stops.map((s) => result.items[s.item]!.place)),
    [day, result],
  );
  const dayLength = day.parts.flatMap((p) => p.stops).reduce((sum, s) => sum + (s.travelMeters ?? 0), 0);
  const dateLabel = (date: string) =>
    new Date(`${date}T12:00:00`).toLocaleDateString(locale, {
      weekday: "short",
      day: "numeric",
      month: "long",
    });
  return (
    <Stack>
      <h2>{t("miniapp.assistant.plan.title")}</h2>
      {plan.days.length > 1 ? (
        <div role="tablist" aria-label={t("miniapp.assistant.plan.days")} className="kosiv-tags">
          {plan.days.map((d, i) => (
            <button
              key={d.dayNo}
              type="button"
              role="tab"
              aria-selected={i === dayIndex}
              className="kosiv-tag"
              onClick={() => setDayIndex(i)}
              data-testid="assistant-plan-day"
            >
              {t("miniapp.assistant.plan.day", { n: d.dayNo })} · {dateLabel(d.date)}
            </button>
          ))}
        </div>
      ) : (
        <p className="kosiv-muted">{dateLabel(day.date)}</p>
      )}
      {dayLength > 0 && (
        <p className="kosiv-muted" data-testid="assistant-plan-length">
          {t("miniapp.assistant.plan.length", { len: distance(dayLength) })}
        </p>
      )}
      {day.transfer && <TransferView transfer={day.transfer} items={result.items} foot={foot} />}
      <MapSlot places={places} center={base?.point ?? null} centerLabel={base?.name} route />
      {day.parts.map((part) => (
        <section key={part.part} className="assistant-plan-part" data-testid="assistant-plan-part">
          <h3>{t(`miniapp.assistant.plan.part.${part.part}` as MessageKey)}</h3>
          <ol className="assistant-list">
            {part.stops.map((s) => (
              <PlanStopView key={s.item} stop={s} item={result.items[s.item]!} />
            ))}
          </ol>
        </section>
      ))}
      <AddToMyPlan plan={plan} items={result.items} withKids={result.intent.withKids} />
    </Stack>
  );
}

function PlanStopView({ stop, item }: { stop: AssistantPlanStop; item: AssistantItem }) {
  const { t } = useT();
  const duration = useDuration();
  return (
    <li data-testid="assistant-plan-stop">
      <p className="assistant-stop">
        <strong>{stop.start}</strong> · {t(`miniapp.assistant.plan.role.${stop.role}` as MessageKey)} ·{" "}
        {duration(stop.durationMin)}
      </p>
      {stop.travel && stop.travelMinutes !== null && (
        <p className="kosiv-muted" data-testid="assistant-plan-travel">
          <span aria-hidden="true">{stop.travel === "walk" ? "🚶 " : "🚗 "}</span>
          {t(stop.travel === "walk" ? "miniapp.assistant.plan.walk" : "miniapp.assistant.plan.car", {
            m: stop.travelMinutes,
          })}
        </p>
      )}
      <PlaceSummaryCard place={item.place} as="div" />
      {(stop.note || stop.hours) && (
        <div className="assistant-extra">
          {/* Пояснение — Claude по фактам каталога; пометку «ШІ» не показываем (SHOW_AI_LABELS). */}
          {stop.note && <p data-testid="assistant-plan-note">{stop.note}</p>}
          {stop.hours && (
            <p className="kosiv-muted">{t("miniapp.assistant.plan.open", { hours: stop.hours })}</p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Переезд в другой район перед днём плана. На авто — расстояние; без авто — такси и трансферы, экскурсионные бюро
 * и автостанция из каталога (что есть рядом) и подсказка уточнять расписание автобусов (в каталоге его нет).
 */
function TransferView({
  transfer,
  items,
  foot,
}: {
  transfer: NonNullable<AssistantPlan["days"][number]["transfer"]>;
  items: readonly AssistantItem[];
  foot: boolean;
}) {
  const { t } = useT();
  const distance = useRadiusLabel();
  const len = distance(transfer.meters);
  const group = (key: MessageKey, idx: readonly number[]) => {
    const list = idx.map((i) => items[i]).filter((x): x is AssistantItem => Boolean(x));
    if (!list.length) return null;
    return (
      <>
        <p>
          <strong>{t(key)}</strong>
        </p>
        <ul className="assistant-list">
          {list.map((item) => (
            <li key={item.place.id}>
              <PlaceSummaryCard place={item.place} as="div" />
            </li>
          ))}
        </ul>
      </>
    );
  };
  return (
    <section className="assistant-transfer" data-testid="assistant-plan-transfer">
      <p>
        <span aria-hidden="true">{foot ? "🚌 " : "🚗 "}</span>
        {t(foot ? "miniapp.assistant.plan.transfer.foot" : "miniapp.assistant.plan.transfer.car", { len })}
      </p>
      {foot && (
        <>
          {group("miniapp.assistant.plan.transfer.taxi", transfer.taxi)}
          {group("miniapp.assistant.plan.transfer.excursions", transfer.excursions)}
          {group("miniapp.assistant.plan.transfer.bus", transfer.busStations)}
          <p className="kosiv-muted" data-testid="assistant-bus-hint">
            {t("miniapp.assistant.plan.transfer.busHint")}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * «Додати в Мій план» (флаг module.host_requests): новый свой план на дни ассистента и галочки мест по частям дня —
 * существующим api «Мій план»; затем — экран плана.
 */
function AddToMyPlan({
  plan,
  items,
  withKids,
}: {
  plan: AssistantPlan;
  items: readonly AssistantItem[];
  withKids: boolean;
}) {
  const { t } = useT();
  const host = useOptionalHost();
  const enabled = useFeatureFlag("module.host_requests");
  const [, navigate] = useRoute();
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const { session, setUi } = useAssistantSession();
  const last = session.turns[session.turns.length - 1];
  const planId = last && session.ui?.turn === last.id ? session.ui.planId : undefined;
  // Пока план создаётся, «Назад» не уводит с экрана: иначе кнопка вернулась бы активной и создала второй.
  useBackStep(state === "busy", () => undefined);
  if (!host || !enabled) return null;
  const add = async () => {
    setState("busy");
    let createdId: string | null = null;
    try {
      const created = await host.api.createPlan({
        adults: 2,
        children: withKids ? 1 : 0,
        withCar: true,
        days: plan.days.length,
        startDate: plan.days[0]?.date ?? null,
      });
      createdId = created.id;
      setUi({ planId: created.id });
      // По одному пункту: api «Мій план» добавляет место галочкой в часть дня.
      for (const d of plan.days)
        for (const p of d.parts)
          for (const s of p.stops)
            await host.api.updatePlan(created.id, {
              add: { day: d.dayNo, slot: p.part, placeId: items[s.item]!.place.id },
            });
      navigate(`/plan/saved/${created.id}`);
    } catch {
      // План уже создан — открываем его (что успели добавить, остальное — галочками там), а не создаём второй.
      if (createdId) {
        markPlanPartial(createdId);
        navigate(`/plan/saved/${createdId}`);
      } else setState("error");
    }
  };
  if (planId && state !== "busy")
    return (
      <Link to={`/plan/saved/${planId}`} className="kosiv-cta" data-testid="assistant-plan-open">
        {t("miniapp.assistant.plan.openSaved")}
      </Link>
    );
  return (
    <>
      <Button onClick={() => void add()} disabled={state === "busy"} data-testid="assistant-plan-add">
        {state === "busy" ? t("miniapp.assistant.plan.adding") : t("miniapp.assistant.plan.add")}
      </Button>
      {state === "error" && <p role="alert">{t("miniapp.assistant.plan.addError")}</p>}
    </>
  );
}

function AssistantPlace({ item, stop }: { item: AssistantItem; stop: number | null }) {
  const { t } = useT();
  const price =
    item.priceLevel !== null && item.priceLevel >= 0 && item.priceLevel <= 4
      ? t(`miniapp.place.price.${item.priceLevel}` as MessageKey)
      : null;
  return (
    <li data-testid="assistant-place">
      {stop !== null && <p className="assistant-stop">{t("miniapp.assistant.stopN", { n: stop })}</p>}
      <PlaceSummaryCard place={item.place} as="div" />
      {(price || item.kidsFriendly || item.description) && (
        <div className="assistant-extra">
          {(price || item.kidsFriendly) && (
            <p className="kosiv-place-meta">
              {price && <span className="kosiv-chip">{price}</span>}
              {item.kidsFriendly && <span className="kosiv-chip">{t("miniapp.assistant.kids")}</span>}
            </p>
          )}
          {item.description && (
            <>
              <p data-testid="assistant-description">{item.description}</p>
              <p className="kosiv-muted assistant-source">
                {item.descriptionUrl ? (
                  <a href={item.descriptionUrl} target="_blank" rel="noopener noreferrer">
                    {t("miniapp.place.wikiReadMore")}
                  </a>
                ) : item.descriptionSource && (SHOW_AI_LABELS || item.descriptionSource !== "ai") ? (
                  t(`miniapp.assistant.source.${item.descriptionSource}` as MessageKey)
                ) : null}
              </p>
            </>
          )}
        </div>
      )}
    </li>
  );
}
