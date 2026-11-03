// Экран ассистента: диалог «реплика → места каталога». Места, цены и описания — только из ответа api (каталог и
// обогащение); модель на сервере выбирает лишь категории и фильтры. Уточнения — следующей репликой или чипом;
// контекст диалога (прежние реплики и намерение) хранится здесь и отправляется с каждым запросом.
import { SHOW_AI_LABELS } from "../ai-labels.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Stack, useFeatureFlag, useRoute, useT } from "@tg/ui";
import { useCategoryIndex, type CategoryIndex } from "../guide/categories.js";
import { useGuide } from "../guide/context.js";
import { useLocations } from "../guide/LocationProvider.js";
import { MapSlot, preloadMap } from "../guide/MapSlot.js";
import { useRadiusLabel } from "../guide/Nearby.js";
import { PlaceSummaryCard } from "../guide/parts.js";
import { useOptionalHost } from "../host/context.js";
import { useErrorText } from "../host/errors.js";
import { markPlanPartial } from "../plan/partial-notice.js";
import type {
  AssistantApi,
  AssistantIntent,
  AssistantItem,
  AssistantPlan,
  AssistantPlanStop,
  AssistantResult,
} from "./assistant-api.js";
import { AssistantBox } from "./AssistantBox.js";

import { clearAssistantDialog, loadDialog, newDialogId, saveDialog, type Turn } from "./dialog-store.js";

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

export function Assistant({ api, initialQuery = "" }: { api: AssistantApi; initialQuery?: string }) {
  const { t } = useT();
  const guide = useGuide();
  const index = useCategoryIndex(guide.api);
  const summary = useIntentSummary(index);
  const errorText = useErrorText();
  const [, navigate] = useRoute();
  // Новый запрос с главной — новый диалог; возврат на #/assistant — прежний диалог из sessionStorage.
  const [restored] = useState(() => (initialQuery.trim() ? null : loadDialog()));
  const dialogId = useRef(restored?.id ?? newDialogId());
  const [turns, setTurns] = useState<Turn[]>(() => restored?.turns ?? []);
  const nextId = useRef(turns.length + 1);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => saveDialog(dialogId.current, turns), [turns]);
  const point = guide.base?.point ?? null;
  const { selected: localityIds } = useLocations();

  const ask = (text: string) => {
    const id = nextId.current++;
    // Контекст — завершённые реплики этого диалога и намерение последнего ответа.
    const done = turns.filter((x) => x.state.status === "ready");
    const lastReady = done[done.length - 1];
    const previous = lastReady?.state.status === "ready" ? lastReady.state.data.intent : null;
    setTurns((all) => [...all, { id, text, state: { status: "loading" } }]);
    api
      .ask({
        text,
        point,
        history: turns.map((x) => x.text),
        previous,
        ...(localityIds.length ? { localityIds } : {}),
      })
      .then(
        (data) => ({ status: "ready", data }) as const,
        (error: unknown) => ({ status: "error", error }) as const,
      )
      .then((state) => {
        // Ушли с экрана до ответа — ответ всё равно сохраняется в диалог (вернёмся — не платим повторно).
        if (!alive.current) {
          // Только в свой диалог: если уже начат новый (другой id), поздний ответ не дописывается.
          const stored = loadDialog();
          const mine = stored?.id === dialogId.current ? stored.turns : stored ? null : [];
          if (state.status === "ready" && mine) saveDialog(dialogId.current, [...mine, { id, text, state }]);
          return;
        }
        setTurns((all) => all.map((x) => (x.id === id ? { ...x, state } : x)));
      });
  };

  // Запрос с главной (#/assistant?q=…) — сразу первой репликой.
  const started = useRef(false);
  useEffect(() => {
    preloadMap().catch(() => undefined);
    if (started.current || !initialQuery.trim()) return;
    started.current = true;
    ask(initialQuery.trim());
    // Адрес без запроса: «Назад» из карточки места вернёт диалог, а не повторит запрос.
    navigate("/assistant", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const last = turns[turns.length - 1];
  const busy = last?.state.status === "loading";
  const result = last?.state.status === "ready" ? last.state.data : null;

  return (
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
          : result && !result.intent.clarify
            ? result.items.length
              ? t("miniapp.assistant.found", { n: result.items.length })
              : t("miniapp.assistant.empty")
            : ""}
      </p>
      {/* key — новый ответ начинает список и дни плана сначала. */}
      {result && <ResultView key={last!.id} result={result} />}
      {result && result.intent.suggestions.length > 0 && (
        <div
          role="group"
          aria-label={t("miniapp.assistant.chips")}
          className="kosiv-tags"
          data-testid="assistant-chips"
        >
          {result.intent.suggestions.map((s) => {
            const label = t(`miniapp.assistant.chip.${s}` as MessageKey);
            return (
              <button key={s} type="button" className="kosiv-tag" disabled={busy} onClick={() => ask(label)}>
                {label}
              </button>
            );
          })}
        </div>
      )}
      <AssistantBox api={api} onSubmit={ask} busy={busy} id="assistant-next" autoFocus={!initialQuery} />
      {turns.length > 0 && (
        <Button
          onClick={() => {
            clearAssistantDialog();
            dialogId.current = newDialogId();
            setTurns([]);
          }}
          disabled={busy}
        >
          {t("miniapp.assistant.newDialog")}
        </Button>
      )}
    </Stack>
  );
}

/** Мест в списке сразу и за нажатие «Показати ще». */
export const PAGE_SIZE = 10;

function ResultView({ result }: { result: AssistantResult }) {
  const { t } = useT();
  const { base } = useGuide();
  const distance = useRadiusLabel();
  const [shown, setShown] = useState(PAGE_SIZE);
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
        <PlanView plan={plan} result={result} />
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
function PlanView({ plan, result }: { plan: AssistantPlan; result: AssistantResult }) {
  const { t, locale } = useT();
  const { base } = useGuide();
  const distance = useRadiusLabel();
  const [dayIndex, setDayIndex] = useState(0);
  const day = plan.days[Math.min(dayIndex, plan.days.length - 1)]!;
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
        <p className="kosiv-muted">
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
                {item.descriptionSource === "wikipedia" && item.descriptionUrl ? (
                  <a href={item.descriptionUrl} target="_blank" rel="noopener noreferrer">
                    {t("miniapp.assistant.source.wikipedia")}
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
