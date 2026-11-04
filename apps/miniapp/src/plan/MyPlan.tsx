// C09 «Мій план»: готовые сценарии региона и сохранённые планы. Сценарий — просмотр по дням и «Зберегти як план».
// План пользователя — параметры поездки (дорослі, діти, з авто / без, днів) и по каждой части дня (ранок, день,
// вечір, «якщо дощ») список с галочками: отмеченное — в плане, ниже — 3–5 вариантов из каталога (что это, чому
// підходить, скільки йти/їхати); галочка — PATCH addItem, снятая — removeItemId. «Скласти свій план» — план без
// сценария. Пункт → картка місця C06. Сохранение — только с сессией (C-24). Погода (module.weather, при дате начала):
// в заголовке дня — иконка и t°, в дне — предупреждения; дождь — «якщо дощ» раскрыт; горный поход в опасный день —
// с предупреждением; подпись источника под днями. Флаг planner.ai: свой план составляет Claude (ожидание
// «Складаємо план…» с пределом PLAN_WAIT_MS), «Інший варіант» — новый план с теми же параметрами.
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Link, Stack, useFeatureFlag, useRoute, useT } from "@tg/ui";
import { useIdempotencyKey } from "../bookings/parts.js";
import { useAsync, useGuide } from "../guide/context.js";
import { AsyncView, Badge, card, listStyle, useDistance } from "../guide/parts.js";
import { useScreenState } from "../screen-state.js";
import { NotFoundError, UnauthorizedError } from "../guide/types.js";
import { useHost } from "../host/context.js";
import { isMessageKey, useErrorText } from "../host/errors.js";
import {
  ApiCallError,
  PLAN_INTERESTS,
  PLAN_SLOTS,
  type PlanChange,
  type PlanDay,
  type PlanDayWeather,
  type PlanItem,
  type PlanOption,
  type PlanPlace,
  type PlanSlot,
  type PlanTrip,
  type ScenarioDetail,
  type ScenarioSummary,
  type TripInput,
  type UserPlan,
} from "../host/types.js";
import {
  formatTemp,
  useConditionText,
  WarningList,
  WeatherAttribution,
  WeatherIcon,
} from "../weather/Weather.js";
import { markPlanFallback, takePlanFallback, takePlanPartial } from "./partial-notice.js";
import "./plan.css";

// Сегменты в стиле переключателя сезонов (.kosiv-seasons): активный — поверхность и акцент.
const tabStyle = (active: boolean): CSSProperties => ({
  flex: 1,
  minHeight: 44,
  padding: "8px 12px",
  border: 0,
  borderRadius: 9999,
  background: active ? "var(--app-surface, var(--color-button))" : "transparent",
  color: active ? "var(--app-accent-ink, var(--color-button-text))" : "var(--color-text)",
  boxShadow: active ? "0 2px 8px -2px rgba(60, 42, 20, 0.18)" : "none",
  font: "inherit",
  fontSize: "0.95rem",
  fontWeight: 600,
  cursor: "pointer",
});

const PEOPLE_MAX = 20;
const DAYS_MAX = 14;
/**
 * Живой план (Claude): дольше — сообщение и ссылка на «Збережені». Сервер укладывается в ~55 с (общий дедлайн обеих
 * попыток), прокси Cloudflare рвёт запрос на 100 с.
 */
export const PLAN_WAIT_MS = 70_000;

export function MyPlan({ tab }: { tab: "scenarios" | "saved" }) {
  const { t } = useT();
  const [, navigate] = useRoute();
  return (
    <Stack>
      <h1>{t("miniapp.plan.title")}</h1>
      <div
        role="group"
        aria-label={t("miniapp.plan.tabs")}
        style={{
          display: "flex",
          gap: 4,
          padding: 4,
          borderRadius: 9999,
          background: "var(--color-surface)",
        }}
      >
        <button
          type="button"
          style={tabStyle(tab === "scenarios")}
          aria-pressed={tab === "scenarios"}
          onClick={() => navigate("/plan", { replace: true })}
        >
          {t("miniapp.plan.scenarios")}
        </button>
        <button
          type="button"
          style={tabStyle(tab === "saved")}
          aria-pressed={tab === "saved"}
          onClick={() => navigate("/plan/saved", { replace: true })}
        >
          {t("miniapp.plan.saved")}
        </button>
      </div>
      <div style={card} data-testid="plan-custom">
        <Link to="/plan/new" style={{ fontSize: "1.2rem", fontWeight: 700 }}>
          {t("miniapp.plan.custom")}
        </Link>
        <p className="kosiv-muted" style={{ margin: "4px 0 0" }}>
          {t("miniapp.plan.customHint")}
        </p>
      </div>
      {tab === "scenarios" ? <ScenarioList /> : <SavedPlans />}
    </Stack>
  );
}

function ScenarioList() {
  const { t, locale } = useT();
  const { api } = useHost();
  // Дата поездки: сценарии её сезона (зимой можно спланировать летнюю поездку); без даты — текущий сезон.
  const [tripDate, setTripDate] = useScreenState("plan.date", "");
  const [list, retry] = useAsync(() => api.scenarios(tripDate || null), [api, tripDate], {
    slot: "plan.scenarios",
    key: tripDate,
  });
  const dateId = useId();
  return (
    <>
      <label htmlFor={dateId} className="plan-date">
        <span>{t("miniapp.plan.trip.startDate")}</span>
        <input
          id={dateId}
          type="date"
          value={tripDate}
          data-testid="scenarios-date"
          onChange={(e) => setTripDate(e.target.value)}
        />
      </label>
      <AsyncView state={list} retry={retry}>
        {(items: ScenarioSummary[]) =>
          items.length ? (
            <ul style={listStyle} data-testid="scenarios">
              {items.map((s) => (
                <li key={s.id} style={card} data-testid="scenario-item">
                  <Link
                    to={`/plan/scenario/${s.id}${tripDate ? `?date=${tripDate}` : ""}`}
                    style={{ fontSize: "1.2rem", fontWeight: 700 }}
                  >
                    {pickLocalized(s.title, locale)}
                  </Link>
                  <span style={{ display: "block" }}>{t("miniapp.plan.days", { n: s.days })}</span>
                  {s.description && (
                    <p style={{ margin: "4px 0 0" }}>{pickLocalized(s.description, locale)}</p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p data-testid="scenarios-empty">{t("miniapp.plan.empty")}</p>
          )
        }
      </AsyncView>
    </>
  );
}

function SavedPlans() {
  const { t, locale } = useT();
  const { signedIn } = useGuide();
  const { api } = useHost();
  const [list, retry] = useAsync(() => (signedIn ? api.plans() : Promise.resolve([])), [api, signedIn]);
  if (!signedIn) return <p data-testid="plans-login">{t("miniapp.plan.needsLogin")}</p>;
  return (
    <AsyncView state={list} retry={retry}>
      {(items: UserPlan[]) =>
        items.length ? (
          <ul style={listStyle} data-testid="saved-plans">
            {items.map((p) => (
              <li key={p.id} style={card} data-testid="saved-plan">
                <Link to={`/plan/saved/${p.id}`} style={{ fontSize: "1.2rem", fontWeight: 700 }}>
                  {pickLocalized(p.title, locale)}
                </Link>
                <span style={{ display: "block" }}>{t("miniapp.plan.days", { n: p.trip.days })}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p data-testid="plans-empty">{t("miniapp.plan.savedEmpty")}</p>
        )
      }
    </AsyncView>
  );
}

// --- параметры поездки ---

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  const { t } = useT();
  const id = useId();
  return (
    <div className="plan-stepper" role="group" aria-labelledby={`${id}-l`}>
      <span id={`${id}-l`} className="plan-stepper-label">
        {label}
      </span>
      <button
        type="button"
        className="plan-stepper-btn"
        aria-label={t("miniapp.plan.trip.decrease", { label })}
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <output className="plan-stepper-value" aria-live="polite" data-testid={`trip-${label}`}>
        {value}
      </output>
      <button
        type="button"
        className="plan-stepper-btn"
        aria-label={t("miniapp.plan.trip.increase", { label })}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </div>
  );
}

const DEFAULT_TRIP: PlanTrip = { adults: 2, children: 0, withCar: true, days: 1 };

/** Форма параметров: дорослі, діти, з авто / без, днів, дата початку. */
function TripForm({
  initial,
  startDate,
  submitLabel,
  busy,
  trimFrom,
  onSubmit,
}: {
  initial: PlanTrip;
  startDate: string | null;
  submitLabel: string;
  busy: boolean;
  /** Сколько дней сейчас в плане: меньше — предупреждение «пункти буде прибрано». */
  trimFrom?: number;
  onSubmit: (trip: PlanTrip, startDate: string | null) => void;
}) {
  const { t } = useT();
  const [trip, setTrip] = useState(initial);
  const [date, setDate] = useState(startDate ?? "");
  const aiOn = useFeatureFlag("planner.ai");
  const interests = trip.interests ?? [];
  const dateId = useId();
  const set = (patch: Partial<PlanTrip>) => setTrip((v) => ({ ...v, ...patch }));
  return (
    <form
      className="plan-trip-form"
      data-testid="trip-form"
      onSubmit={(e) => {
        e.preventDefault();
        // Интересы — только для живого плана (флаг planner.ai).
        const { interests, ...rest } = trip;
        onSubmit(aiOn && interests ? { ...rest, interests } : rest, date || null);
      }}
    >
      <Stepper
        label={t("miniapp.plan.trip.adults")}
        value={trip.adults}
        min={1}
        max={PEOPLE_MAX}
        onChange={(adults) => set({ adults })}
      />
      <Stepper
        label={t("miniapp.plan.trip.children")}
        value={trip.children}
        min={0}
        max={PEOPLE_MAX}
        onChange={(children) => set({ children })}
      />
      <Stepper
        label={t("miniapp.plan.trip.days")}
        value={trip.days}
        min={1}
        max={DAYS_MAX}
        onChange={(days) => set({ days })}
      />
      <div role="group" aria-label={t("miniapp.plan.trip.transport")} className="kosiv-seasons plan-car">
        {[true, false].map((car) => (
          <button
            key={String(car)}
            type="button"
            className="kosiv-season"
            aria-pressed={trip.withCar === car}
            onClick={() => set({ withCar: car })}
          >
            {t(car ? "miniapp.plan.trip.withCar" : "miniapp.plan.trip.noCar")}
          </button>
        ))}
      </div>
      {aiOn && (
        <div
          role="group"
          aria-label={t("miniapp.plan.trip.interests")}
          className="kosiv-seasons plan-interests"
          data-testid="trip-interests"
        >
          {PLAN_INTERESTS.map((i) => (
            <button
              key={i}
              type="button"
              className="kosiv-season"
              aria-pressed={interests.includes(i)}
              onClick={() =>
                set({
                  interests: PLAN_INTERESTS.filter((x) =>
                    x === i ? !interests.includes(i) : interests.includes(x),
                  ),
                })
              }
            >
              {t(`miniapp.plan.interest.${i}`)}
            </button>
          ))}
        </div>
      )}
      <label htmlFor={dateId} className="plan-date">
        <span>{t("miniapp.plan.trip.startDate")}</span>
        <input id={dateId} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      {trip.children > 0 && <p className="kosiv-muted plan-note">{t("miniapp.plan.trip.kidsNote")}</p>}
      {!trip.withCar && <p className="kosiv-muted plan-note">{t("miniapp.plan.trip.noCarNote")}</p>}
      {trimFrom !== undefined && trip.days < trimFrom && (
        <p className="plan-note" role="status">
          {t("miniapp.plan.trip.trimWarning", { n: trip.days })}
        </p>
      )}
      <Button type="submit" disabled={busy} data-testid="trip-submit">
        {submitLabel}
      </Button>
    </form>
  );
}

/** «Скласти свій план»: параметры → план без сценария → экран плана с вариантами. */
export function NewPlanScreen() {
  const { t } = useT();
  const { signedIn } = useGuide();
  const { api, hotelPlaceId } = useHost();
  const [, navigate] = useRoute();
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Message>(null);
  const [waitedTooLong, setWaitedTooLong] = useState(false);
  const aiOn = useFeatureFlag("planner.ai");
  // Повтор того же запроса (после таймаута, сети) — тот же Idempotency-Key: второй план не создаётся, лимит не тратится.
  const idem = useIdempotencyKey();
  const create = async (trip: PlanTrip, startDate: string | null) => {
    setBusy(true);
    setWaitedTooLong(false);
    setStatus(aiOn ? { text: t("miniapp.plan.ai.generating"), alert: false } : null);
    // Без вечного ожидания: дольше PLAN_WAIT_MS — сообщение и «Збережені плани» (поздний ответ всё равно откроет план).
    const timer = aiOn
      ? window.setTimeout(() => {
          setStatus({ text: t("miniapp.plan.ai.timeout"), alert: true });
          setWaitedTooLong(true);
          setBusy(false);
        }, PLAN_WAIT_MS)
      : undefined;
    const input: TripInput = { ...trip, startDate, ...(hotelPlaceId ? { basePlaceId: hotelPlaceId } : {}) };
    try {
      const plan = await api.createPlan(input, idem.keyFor(input));
      idem.settle();
      if (plan.generation === "fallback") markPlanFallback(plan.id);
      navigate(`/plan/saved/${plan.id}`, { replace: true });
    } catch (err) {
      idem.settle(err);
      setStatus({ text: errorText(err, "miniapp.plan.createError"), alert: true });
      setBusy(false);
    } finally {
      window.clearTimeout(timer);
    }
  };
  return (
    <Stack>
      <h1>{t("miniapp.plan.newTitle")}</h1>
      <Link to="/plan" style={{ fontSize: "1.2rem", fontWeight: 700 }}>
        {t("miniapp.plan.backToList")}
      </Link>
      <p>{t("miniapp.plan.customHint")}</p>
      {signedIn ? (
        <>
          <TripForm
            initial={DEFAULT_TRIP}
            startDate={null}
            submitLabel={t(aiOn ? "miniapp.plan.ai.create" : "miniapp.plan.trip.create")}
            busy={busy}
            onSubmit={(trip, date) => void create(trip, date)}
          />
          <Live message={status} testId="plan-status" />
          {waitedTooLong && (
            <Link to="/plan/saved" data-testid="plan-open-saved">
              {t("miniapp.plan.ai.openSaved")}
            </Link>
          )}
        </>
      ) : (
        <p data-testid="plan-login">{t("miniapp.plan.needsLogin")}</p>
      )}
    </Stack>
  );
}

// --- сценарий ---

/** Дата поездки из адреса (#/plan/scenario/<id>?date=YYYY-MM-DD) — со списка сценариев; иначе null. */
export function tripDateFromHash(hash: string = window.location.hash): string | null {
  const d = new URLSearchParams(hash.split("?")[1] ?? "").get("date");
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

export function ScenarioScreen({ id }: { id: string }) {
  const { api } = useHost();
  const [s, retry] = useAsync(() => api.scenario(id), [api, id]);
  const startDate = tripDateFromHash();
  return (
    <AsyncView state={s} retry={retry}>
      {(sc) => <ScenarioView scenario={sc} startDate={startDate} />}
    </AsyncView>
  );
}

/** Готовый сценарий: просмотр по дням; правки — после «Зберегти як план» (план пользователя на сервере). */
function ScenarioView({ scenario, startDate }: { scenario: ScenarioDetail; startDate: string | null }) {
  const { t, locale } = useT();
  const { signedIn } = useGuide();
  const { api } = useHost();
  const [, navigate] = useRoute();
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Message>(null);
  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      // Дата поездки со списка — в план: варианты на выбор считаются по её сезону.
      const plan = await api.savePlan(scenario.id, startDate);
      navigate(`/plan/saved/${plan.id}`, { replace: true });
    } catch (err) {
      setStatus({ text: errorText(err, "miniapp.plan.saveError"), alert: true });
      setBusy(false);
    }
  };
  return (
    <Stack>
      <h1>{pickLocalized(scenario.title, locale)}</h1>
      {scenario.adLabel && (
        <span>
          <Badge>{t(scenario.adLabel === "partner" ? "miniapp.place.partner" : "miniapp.place.ad")}</Badge>
        </span>
      )}
      {scenario.description && <p>{pickLocalized(scenario.description, locale)}</p>}
      <Link to="/plan" style={{ fontSize: "1.2rem", fontWeight: 700 }}>
        {t("miniapp.plan.backToList")}
      </Link>
      <Days days={scenario.schedule} />
      <Live message={status} testId="plan-status" />
      {signedIn ? (
        <Button onClick={() => void save()} disabled={busy} data-testid="plan-save">
          {t("miniapp.plan.save")}
        </Button>
      ) : (
        <p data-testid="plan-login">{t("miniapp.plan.needsLogin")}</p>
      )}
    </Stack>
  );
}

function Days({ days }: { days: PlanDay[] }) {
  const { t } = useT();
  return (
    <>
      {days.map((d) => (
        <section key={d.day} aria-labelledby={`day-${d.day}`} data-testid="plan-day">
          <h2 id={`day-${d.day}`} style={{ fontSize: "1.1rem" }}>
            {t("miniapp.plan.day", { n: d.day })}
          </h2>
          {d.items.length ? (
            <ol style={listStyle}>
              {d.items.map((i) => (
                <ScenarioItemRow key={i.id} item={i} />
              ))}
            </ol>
          ) : (
            <p>{t("miniapp.plan.dayEmpty")}</p>
          )}
        </section>
      ))}
    </>
  );
}

function ScenarioItemRow({ item }: { item: PlanItem }) {
  const { t, locale } = useT();
  const distance = useDistance();
  const name = item.place ? pickLocalized(item.place.name, locale) : t("miniapp.plan.unavailable");
  const d = distance(item.distanceMeters);
  return (
    <li style={card} data-testid="plan-item">
      {item.time && <span style={{ fontWeight: 700, marginRight: 8 }}>{item.time}</span>}
      {item.place ? (
        <Link
          to={`/place/${encodeURIComponent(item.place.id)}`}
          style={{ fontSize: "1.2rem", fontWeight: 700 }}
        >
          {name}
        </Link>
      ) : (
        <strong data-testid="plan-item-unavailable">{name}</strong>
      )}
      {d && <span style={{ display: "block" }}>{t("miniapp.plan.distance", { n: d })}</span>}
      {item.note && <p style={{ margin: "4px 0" }}>{pickLocalized(item.note, locale)}</p>}
    </li>
  );
}

// --- план пользователя ---

export function SavedPlanScreen({ id }: { id: string }) {
  const { t } = useT();
  const { api } = useHost();
  const { signedIn } = useGuide();
  const [plan, retry] = useAsync(
    () => (signedIn ? api.plan(id) : Promise.reject(new UnauthorizedError())),
    [api, id, signedIn],
  );
  // Ассистент добавил не все места — сообщаем один раз (флаг снимается при первом показе экрана).
  const [partial] = useState(() => takePlanPartial(id));
  const [fallback] = useState(() => takePlanFallback(id));
  if (plan.status === "error" && plan.error instanceof NotFoundError)
    return <p role="alert">{t("miniapp.plan.notFound")}</p>;
  if (plan.status === "error" && plan.error instanceof UnauthorizedError)
    return <p role="alert">{t("miniapp.plan.needsLogin")}</p>;
  return (
    <>
      {partial && (
        <p role="status" data-testid="plan-partial">
          {t("miniapp.assistant.plan.partial")}
        </p>
      )}
      {fallback && (
        <p role="status" data-testid="plan-ai-fallback">
          {t("miniapp.plan.ai.fallback")}
        </p>
      )}
      <AsyncView state={plan} retry={retry}>
        {(p) => <PlanEditor key={p.id} initial={p} />}
      </AsyncView>
    </>
  );
}

type Message = { text: string; alert: boolean } | null;

function Live({ message, testId }: { message: Message; testId: string }) {
  return (
    <p role={message?.alert ? "alert" : "status"} data-testid={testId}>
      {message?.text ?? ""}
    </p>
  );
}

type Edit = {
  busy: boolean;
  /** focusPlace — после ответа фокус на галочку этого места (строка перерисовывается в другом списке). */
  apply: (change: PlanChange, done: string, focusPlace?: string) => void;
};

/** Дата дня плана: «пн, 10.11» (локальная дата без часового пояса). */
function dayDate(start: string | null, day: number, locale: string): string | null {
  if (!start) return null;
  const [y, m, d] = start.split("-").map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d + day - 1);
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "2-digit", month: "2-digit" }).format(date);
}

/**
 * Сохранённый план: параметры поездки (свернуты в строку, «Змінити параметри»), по дням — части дня с галочками.
 * Каждое изменение — PATCH /me/plan/{id}, ответ — новый план с пересчитанными вариантами.
 */
function PlanEditor({ initial }: { initial: UserPlan }) {
  const { t, locale } = useT();
  const { api } = useHost();
  const [plan, setPlan] = useState(initial);
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [editTrip, setEditTrip] = useState(false);
  const [status, setStatus] = useState<Message>(null);
  const [focusPlace, setFocusPlace] = useState<string | null>(null);
  const daysRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusPlace) return;
    [...(daysRef.current?.querySelectorAll<HTMLInputElement>("input[data-place-id]") ?? [])]
      .find((el) => el.dataset.placeId === focusPlace)
      ?.focus();
    setFocusPlace(null);
  }, [plan, focusPlace]);
  const apply = async (change: PlanChange, done: string, focus?: string) => {
    setBusy(true);
    setStatus(null);
    try {
      setPlan(await api.updatePlan(plan.id, change));
      setStatus({ text: done, alert: false });
      if (focus) setFocusPlace(focus);
      return true;
    } catch (err) {
      setStatus({ text: errorText(err, "miniapp.plan.changeError"), alert: true });
      // Конфликт или отказ (уже в плане, место снято, лимит) — показанный план устарел: перечитываем.
      if (err instanceof ApiCallError && (err.status === 409 || err.status === 422))
        await api.plan(plan.id).then(setPlan, () => undefined);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const edit: Edit = { busy, apply: (c, done, focus) => void apply(c, done, focus) };
  const weatherOn = useFeatureFlag("module.weather");
  const aiOn = useFeatureFlag("planner.ai");
  const [confirmReplace, setConfirmReplace] = useState(false);
  const regenKey = useIdempotencyKey();
  /**
   * «Інший варіант»: новый план через Claude с теми же параметрами; не вышло — план без изменений. Поздний ответ (после
   * PLAN_WAIT_MS) — план перечитывается: за это время его могли изменить. План изменили на сервере — 409, перечитываем.
   */
  const another = async () => {
    setConfirmReplace(false);
    setBusy(true);
    setStatus({ text: t("miniapp.plan.ai.anotherGenerating"), alert: false });
    let late = false;
    const timer = window.setTimeout(() => {
      late = true;
      setStatus({ text: t("miniapp.plan.ai.timeout"), alert: true });
      setBusy(false);
    }, PLAN_WAIT_MS);
    try {
      const next = await api.regeneratePlan(plan.id, regenKey.keyFor({ plan: plan.id, at: plan.updatedAt }));
      regenKey.settle();
      setPlan(late ? await api.plan(plan.id) : next);
      setStatus(
        next.generation === "ai"
          ? { text: t("miniapp.plan.ai.anotherDone"), alert: false }
          : { text: t("miniapp.plan.ai.anotherFailed"), alert: true },
      );
    } catch (err) {
      regenKey.settle(err);
      setStatus({ text: errorText(err, "miniapp.plan.ai.anotherFailed"), alert: true });
      if (err instanceof ApiCallError && err.status === 409)
        await api.plan(plan.id).then(setPlan, () => undefined);
    } finally {
      window.clearTimeout(timer);
      setBusy(false);
    }
  };
  const hasItems = plan.schedule.some((d) => d.items.length > 0);
  const { trip } = plan;
  return (
    <Stack>
      <h1>{pickLocalized(plan.title, locale)}</h1>
      {plan.scenarioUpdated && <p>{t("miniapp.plan.scenarioUpdated")}</p>}
      <Link to="/plan/saved" style={{ fontSize: "1.2rem", fontWeight: 700 }}>
        {t("miniapp.plan.backToList")}
      </Link>
      <section style={card} aria-labelledby="trip-title" data-testid="trip-summary">
        <h2 id="trip-title" style={{ fontSize: "1.1rem", margin: 0 }}>
          {t("miniapp.plan.trip.title")}
        </h2>
        <p style={{ margin: "4px 0" }} data-testid="trip-line">
          {t("miniapp.plan.trip.summary", {
            adults: trip.adults,
            children: trip.children,
            car: t(trip.withCar ? "miniapp.plan.trip.withCar" : "miniapp.plan.trip.noCar"),
            days: trip.days,
          })}
        </p>
        {plan.base && (
          <p className="kosiv-muted" style={{ margin: "0 0 8px" }}>
            {t("miniapp.plan.trip.base", { name: pickLocalized(plan.base, locale) })}
          </p>
        )}
        {weatherOn && !plan.startDate && (
          <p className="kosiv-muted" style={{ margin: "0 0 8px" }} data-testid="plan-weather-nodate">
            {t("miniapp.plan.weather.noDate")}
          </p>
        )}
        {editTrip ? (
          <TripForm
            initial={trip}
            startDate={plan.startDate}
            submitLabel={t("miniapp.plan.trip.save")}
            busy={busy}
            trimFrom={trip.days}
            onSubmit={(next, startDate) =>
              void apply({ trip: { ...next, startDate } }, t("miniapp.plan.trip.saved")).then(
                (ok) => ok && setEditTrip(false),
              )
            }
          />
        ) : (
          <Button disabled={busy} onClick={() => setEditTrip(true)} data-testid="trip-edit">
            {t("miniapp.plan.trip.edit")}
          </Button>
        )}
        {aiOn && plan.scenarioId === null && !editTrip && !confirmReplace && (
          <Button
            disabled={busy}
            onClick={() => (hasItems ? setConfirmReplace(true) : void another())}
            data-testid="plan-regenerate"
          >
            {t("miniapp.plan.ai.another")}
          </Button>
        )}
        {confirmReplace && (
          <div role="group" aria-labelledby="plan-replace-q" data-testid="plan-replace-confirm">
            <p id="plan-replace-q" className="plan-note">
              {t("miniapp.plan.ai.replaceConfirm")}
            </p>
            <Button disabled={busy} onClick={() => void another()} data-testid="plan-replace">
              {t("miniapp.plan.ai.replace")}
            </Button>
            <Button onClick={() => setConfirmReplace(false)}>{t("miniapp.plan.ai.keep")}</Button>
          </div>
        )}
      </section>
      <Live message={status} testId="plan-status" />
      <div ref={daysRef} className="plan-days">
        {plan.schedule.map((d) => (
          <DaySection
            key={d.day}
            day={d}
            date={dayDate(plan.startDate, d.day, locale)}
            initiallyOpen={d.day === openDay(plan.startDate, plan.schedule.length)}
            options={plan.options.find((o) => o.day === d.day)?.slots ?? []}
            weather={plan.weather.find((w) => w.day === d.day) ?? null}
            edit={edit}
          />
        ))}
      </div>
      {plan.weatherSource && plan.weather.length > 0 && <WeatherAttribution source={plan.weatherSource} />}
    </Stack>
  );
}

/** Какой день открыт сначала: сегодняшний по дате начала, иначе первый. */
function openDay(start: string | null, days: number, now = new Date()): number {
  if (!start) return 1;
  const [y, m, d] = start.split("-").map(Number);
  if (!y || !m || !d) return 1;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const n = Math.round((today.getTime() - new Date(y, m - 1, d).getTime()) / 86_400_000) + 1;
  return n >= 1 && n <= days ? n : 1;
}

/** Кнопка-заголовок раздела: свернуть/развернуть (aria-expanded, aria-controls). */
function Disclosure({
  open,
  onToggle,
  controls,
  children,
  testId,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className="plan-toggle"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      data-testid={testId}
    >
      <span className="plan-toggle-text">{children}</span>
      <span className="plan-toggle-icon" aria-hidden="true">
        {open ? "−" : "+"}
      </span>
    </button>
  );
}

/** День плана: свёрнут — заголовок и «Обрано: N»; развёрнут — части дня. */
function DaySection({
  day,
  date,
  initiallyOpen,
  options,
  weather,
  edit,
}: {
  day: PlanDay;
  date: string | null;
  initiallyOpen: boolean;
  options: { slot: PlanSlot; options: PlanOption[] }[];
  weather: PlanDayWeather | null;
  edit: Edit;
}) {
  const { t } = useT();
  const text = useConditionText();
  const [open, setOpen] = useScreenState(`plan.day.${day.day}`, initiallyOpen);
  const bodyId = `day-${day.day}-body`;
  return (
    <section aria-labelledby={`day-${day.day}`} data-testid="plan-day" data-open={open} className="plan-day">
      <h2 id={`day-${day.day}`} className="plan-day-title">
        <Disclosure open={open} onToggle={() => setOpen((o) => !o)} controls={bodyId}>
          {t("miniapp.plan.day", { n: day.day })}
          {date && <span className="kosiv-muted plan-day-date"> · {date}</span>}
          {weather && (
            <span className="plan-day-weather" data-testid="plan-day-weather">
              <WeatherIcon
                condition={weather.condition}
                iconUrl={weather.iconUrl}
                label={text(weather)}
                size={20}
              />
              {[formatTemp(weather.temperatureMax), formatTemp(weather.temperatureMin)]
                .filter(Boolean)
                .join(" / ")}
              {weather.warnings.length > 0 && <span aria-hidden="true">⚠️</span>}
            </span>
          )}
          <span className="plan-day-count" data-testid="day-chosen">
            {t("miniapp.plan.chosenCount", { n: day.items.filter((i) => i.slot !== "rain").length })}
          </span>
        </Disclosure>
      </h2>
      <div id={bodyId} className="plan-day-body" hidden={!open}>
        {weather && <WarningList warnings={weather.warnings} testId="plan-day-warnings" />}
        {weather?.noMountains && (
          <p className="kosiv-muted plan-weather-note" data-testid="plan-no-mountains">
            {t("miniapp.plan.weather.noMountains")}
          </p>
        )}
        {PLAN_SLOTS.map((slot) => (
          <SlotSection
            key={slot}
            day={day.day}
            slot={slot}
            rainy={weather?.rainy ?? false}
            items={day.items.filter((i) => i.slot === slot)}
            options={options.find((s) => s.slot === slot)?.options ?? []}
            edit={edit}
          />
        ))}
      </div>
    </section>
  );
}

/** Сколько вариантов видно сразу; остальные — в «Ще варіанти». */
const OPTIONS_VISIBLE = 3;

/**
 * Часть дня: отмеченные (в плане) и варианты на выбор — сразу до трёх, остальные в «Ще варіанти»; после выбора все
 * варианты свёрнуты. План Б «якщо дощ» свёрнут целиком, пока в нём ничего не выбрано.
 */
function SlotSection({
  day,
  slot,
  rainy = false,
  items,
  options,
  edit,
}: {
  day: number;
  slot: PlanSlot;
  /** По прогнозу дождь — «якщо дощ» раскрыт сразу. */
  rainy?: boolean;
  items: PlanItem[];
  options: PlanOption[];
  edit: Edit;
}) {
  const { t } = useT();
  const headingId = `day-${day}-${slot}`;
  const [open, setOpen] = useScreenState(
    `plan.slot.${day}.${slot}`,
    slot !== "rain" || items.length > 0 || rainy,
  );
  // Прогноз изменился (план перечитан) и обещает дождь — раскрыть «якщо дощ»; свернуть сам не сворачиваем.
  useEffect(() => {
    if (rainy) setOpen(true);
  }, [rainy, setOpen]);
  const list = (opts: PlanOption[]) => (
    <ul className="plan-choices" aria-label={t("miniapp.plan.options")}>
      {opts.map((o) => (
        <OptionRow key={o.place.id} day={day} slot={slot} option={o} edit={edit} />
      ))}
    </ul>
  );
  const more = (opts: PlanOption[]) => (
    <details className="plan-more">
      <summary>{t("miniapp.plan.moreOptions", { n: opts.length })}</summary>
      {list(opts)}
    </details>
  );
  const body = (
    <>
      {slot === "rain" && rainy && (
        <p className="plan-note" data-testid="plan-rain-forecast">
          <span aria-hidden="true">🌧️</span> {t("miniapp.plan.weather.rain")}
        </p>
      )}
      {slot === "rain" && <p className="kosiv-muted plan-note">{t("miniapp.plan.rainHint")}</p>}
      {items.length ? (
        <ul className="plan-choices" aria-labelledby={headingId}>
          {items.map((i) => (
            <ChosenRow key={i.id} item={i} edit={edit} />
          ))}
        </ul>
      ) : (
        <p className="kosiv-muted plan-note">{t("miniapp.plan.chosenNone")}</p>
      )}
      {!options.length ? (
        <p className="kosiv-muted">{t("miniapp.plan.noOptions")}</p>
      ) : items.length ? (
        more(options)
      ) : (
        <>
          <h4 className="plan-options-title">{t("miniapp.plan.options")}</h4>
          {list(options.slice(0, OPTIONS_VISIBLE))}
          {options.length > OPTIONS_VISIBLE && more(options.slice(OPTIONS_VISIBLE))}
        </>
      )}
    </>
  );
  return (
    <section
      className={`plan-slot plan-slot-${slot}`}
      aria-labelledby={headingId}
      data-testid={`plan-slot-${slot}`}
    >
      <h3 id={headingId} className="plan-slot-title">
        {slot === "rain" ? (
          <Disclosure open={open} onToggle={() => setOpen((o) => !o)} controls={`${headingId}-body`}>
            {t("miniapp.plan.slot.rain")}
          </Disclosure>
        ) : (
          t(`miniapp.plan.slot.${slot}` as MessageKey)
        )}
      </h3>
      <div id={`${headingId}-body`} className="plan-slot-body" hidden={!open}>
        {body}
      </div>
    </section>
  );
}

function Choice({
  checked,
  busy,
  placeId,
  label,
  onChange,
  children,
  testId,
  labelTestId,
}: {
  checked: boolean;
  /** Идёт запрос: галочка не блокируется (фокус не теряется), но изменения игнорируются (aria-disabled). */
  busy: boolean;
  placeId: string | null;
  label: string;
  onChange: () => void;
  children?: ReactNode;
  testId: string;
  labelTestId?: string;
}) {
  const id = useId();
  // Галочка меняется сразу (пока идёт PATCH); ответ сервера — источник истины, ошибка — галочка как была.
  const [pending, setPending] = useState(false);
  // Сбрасываем только при переходе занято → свободно: отложенный эффект первого рендера иначе
  // выполняется после клика и затирает setPending(true) (галочка «не ставится»).
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) setPending(false);
    wasBusy.current = busy;
  }, [busy]);
  const shown = pending ? !checked : checked;
  return (
    <li className="plan-choice" data-checked={shown} data-testid={testId}>
      <input
        id={id}
        type="checkbox"
        className="plan-check"
        checked={shown}
        aria-disabled={busy}
        data-place-id={placeId ?? undefined}
        aria-describedby={`${id}-d`}
        onChange={() => {
          if (busy) return;
          setPending(true);
          onChange();
        }}
      />
      <div className="plan-choice-body">
        <label htmlFor={id} className="plan-choice-name" data-testid={labelTestId}>
          {label}
        </label>
        <div id={`${id}-d`} className="plan-choice-meta">
          {children}
        </div>
      </div>
    </li>
  );
}

/** Подпись «что это»: перевод вида (Ресторан, Водоспад, Бар…), иначе — название категории справочника. */
function useKindLabel(): (o: PlanOption) => string {
  const { t, locale } = useT();
  return (o) => {
    const key = `miniapp.plan.kind.${o.kind}`;
    return isMessageKey(key) ? t(key) : pickLocalized(o.place.categoryName, locale);
  };
}

function travelText(o: PlanOption, t: (k: MessageKey, p?: Record<string, string | number>) => string) {
  if (o.travel === null || o.travelMinutes === null) return null;
  return t(`miniapp.plan.travel.${o.travel}` as MessageKey, { min: o.travelMinutes });
}

function OptionRow({
  day,
  slot,
  option,
  edit,
}: {
  day: number;
  slot: PlanSlot;
  option: PlanOption;
  edit: Edit;
}) {
  const { t, locale } = useT();
  const distance = useDistance();
  const kind = useKindLabel();
  const name = pickLocalized(option.place.name, locale);
  const d = distance(option.distanceMeters);
  const travel = travelText(option, t);
  return (
    <Choice
      checked={false}
      busy={edit.busy}
      placeId={option.place.id}
      label={name}
      testId="plan-option"
      onChange={() =>
        edit.apply(
          { add: { day, slot, placeId: option.place.id } },
          t("miniapp.plan.added", { name }),
          option.place.id,
        )
      }
    >
      <span className="kosiv-chip" data-tone="accent" data-testid="option-kind">
        {kind(option)}
      </span>
      <span className="plan-reason">{t(`miniapp.plan.reason.${option.reason}` as MessageKey)}</span>
      <span className="plan-chips">
        {d && <span className="kosiv-chip">{d}</span>}
        {travel && (
          <span className="kosiv-chip" data-tone={option.travel === "transport" ? "outline" : undefined}>
            {travel}
          </span>
        )}
        {option.kidsFriendly && (
          <span className="kosiv-chip" data-tone="accent2">
            {t("miniapp.plan.kidsFriendly")}
          </span>
        )}
      </span>
      <Link
        to={`/place/${encodeURIComponent(option.place.id)}`}
        aria-label={t("miniapp.plan.details", { name })}
      >
        {t("miniapp.plan.detailsShort")}
      </Link>
    </Choice>
  );
}

/** Отмеченный пункт плана: снять галочку — убрать; «Замінити» — альтернатива из сценария. */
function ChosenRow({ item, edit }: { item: PlanItem; edit: Edit }) {
  const { t, locale } = useT();
  const distance = useDistance();
  const [open, setOpen] = useState(false);
  const name = item.place ? pickLocalized(item.place.name, locale) : t("miniapp.plan.unavailable");
  const d = distance(item.distanceMeters);
  const replace = (p: PlanPlace) => {
    setOpen(false);
    edit.apply(
      { replace: { itemId: item.id, placeId: p.id } },
      t("miniapp.plan.replaced", { name: pickLocalized(p.name, locale) }),
    );
  };
  return (
    <Choice
      checked
      busy={edit.busy}
      placeId={item.place?.id ?? null}
      label={name}
      testId="plan-item"
      labelTestId={item.place ? undefined : "plan-item-unavailable"}
      onChange={() => edit.apply({ remove: item.id }, t("miniapp.plan.removed", { name }), item.place?.id)}
    >
      {item.time && <span className="kosiv-chip">{item.time}</span>}
      {item.weatherWarnings && item.weatherWarnings.length > 0 && (
        <span className="plan-reason" role="note" data-testid="plan-item-weather">
          <span aria-hidden="true">⚠️</span>{" "}
          {t("miniapp.plan.weather.hike", {
            warnings: item.weatherWarnings
              .map((w) => t(`miniapp.weather.warning.${w}` as MessageKey).toLowerCase())
              .join(", "),
          })}
        </span>
      )}
      {d && <span className="plan-reason">{t("miniapp.plan.distance", { n: d })}</span>}
      {item.note && <span className="plan-reason">{pickLocalized(item.note, locale)}</span>}
      <span className="plan-chips">
        {item.place && (
          <Link
            to={`/place/${encodeURIComponent(item.place.id)}`}
            aria-label={t("miniapp.plan.details", { name })}
          >
            {t("miniapp.plan.detailsShort")}
          </Link>
        )}
        {item.alternatives.length > 0 && (
          <Button
            aria-expanded={open}
            aria-label={`${t("miniapp.plan.replace")}: ${name}`}
            disabled={edit.busy}
            onClick={() => setOpen((o) => !o)}
          >
            {t("miniapp.plan.replace")}
          </Button>
        )}
      </span>
      {open && (
        <div role="group" aria-label={t("miniapp.plan.alternatives", { name })} data-testid="alternatives">
          <ul style={{ ...listStyle, marginTop: 8 }}>
            {item.alternatives.map((a) => (
              <li key={a.id}>
                <Button disabled={edit.busy} onClick={() => replace(a)}>
                  {t("miniapp.plan.replaceWith", { name: pickLocalized(a.name, locale) })}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Choice>
  );
}
