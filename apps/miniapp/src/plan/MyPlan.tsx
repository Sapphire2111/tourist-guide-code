// C09 «Мій план»: готовые сценарии региона и сохранённые планы; сценарий по дням, замена пункта альтернативой,
// удаление пункта, «Зберегти як план» (UserPlan). Пункт → картка місця C06. Сохранение — только с сессией (C-24).
import { useState, type CSSProperties } from "react";
import { pickLocalized } from "@tg/i18n";
import { Button, Link, Stack, useRoute, useT } from "@tg/ui";
import { useAsync, useGuide } from "../guide/context.js";
import { AsyncView, Badge, card, listStyle, useDistance } from "../guide/parts.js";
import { NotFoundError, UnauthorizedError } from "../guide/types.js";
import { useHost } from "../host/context.js";
import type {
  PlanChange,
  PlanDay,
  PlanItem,
  PlanPlace,
  ScenarioDetail,
  ScenarioSummary,
  UserPlan,
} from "../host/types.js";

const tabStyle = (active: boolean): CSSProperties => ({
  flex: 1,
  padding: "10px 12px",
  border: "1px solid var(--color-button)",
  borderRadius: "var(--radius)",
  background: active ? "var(--color-button)" : "var(--color-bg)",
  color: active ? "var(--color-button-text)" : "var(--color-text)",
  fontSize: "1.2rem",
  fontWeight: 700,
});

export function MyPlan({ tab }: { tab: "scenarios" | "saved" }) {
  const { t } = useT();
  const [, navigate] = useRoute();
  return (
    <Stack>
      <h1>{t("miniapp.plan.title")}</h1>
      <div role="group" aria-label={t("miniapp.plan.tabs")} style={{ display: "flex", gap: 8 }}>
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
      {tab === "scenarios" ? <ScenarioList /> : <SavedPlans />}
    </Stack>
  );
}

function ScenarioList() {
  const { t, locale } = useT();
  const { api } = useHost();
  const [list, retry] = useAsync(() => api.scenarios(), [api]);
  return (
    <AsyncView state={list} retry={retry}>
      {(items: ScenarioSummary[]) =>
        items.length ? (
          <ul style={listStyle} data-testid="scenarios">
            {items.map((s) => (
              <li key={s.id} style={card} data-testid="scenario-item">
                <Link to={`/plan/scenario/${s.id}`} style={{ fontSize: "1.2rem", fontWeight: 700 }}>
                  {pickLocalized(s.title, locale)}
                </Link>
                <span style={{ display: "block" }}>{t("miniapp.plan.days", { n: s.days })}</span>
                {s.description && <p style={{ margin: "4px 0 0" }}>{pickLocalized(s.description, locale)}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p data-testid="scenarios-empty">{t("miniapp.plan.empty")}</p>
        )
      }
    </AsyncView>
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
                <span style={{ display: "block" }}>{t("miniapp.plan.days", { n: p.schedule.length })}</span>
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

export function ScenarioScreen({ id }: { id: string }) {
  const { api } = useHost();
  const [s, retry] = useAsync(() => api.scenario(id), [api, id]);
  return (
    <AsyncView state={s} retry={retry}>
      {(sc) => <ScenarioView scenario={sc} />}
    </AsyncView>
  );
}

/** Готовый сценарий: просмотр по дням; правки — после «Зберегти як план» (план пользователя на сервере). */
function ScenarioView({ scenario }: { scenario: ScenarioDetail }) {
  const { t, locale } = useT();
  const { signedIn } = useGuide();
  const { api } = useHost();
  const [, navigate] = useRoute();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Message>(null);
  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const plan = await api.savePlan(scenario.id);
      navigate(`/plan/saved/${plan.id}`, { replace: true });
    } catch {
      setStatus({ text: t("miniapp.plan.saveError"), alert: true });
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

export function SavedPlanScreen({ id }: { id: string }) {
  const { t } = useT();
  const { api } = useHost();
  const { signedIn } = useGuide();
  const [plan, retry] = useAsync(
    () => (signedIn ? api.plan(id) : Promise.reject(new UnauthorizedError())),
    [api, id, signedIn],
  );
  if (plan.status === "error" && plan.error instanceof NotFoundError)
    return <p role="alert">{t("miniapp.plan.notFound")}</p>;
  if (plan.status === "error" && plan.error instanceof UnauthorizedError)
    return <p role="alert">{t("miniapp.plan.needsLogin")}</p>;
  return (
    <AsyncView state={plan} retry={retry}>
      {(p) => <PlanEditor key={p.id} initial={p} />}
    </AsyncView>
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

/** Сохранённый план: «Замінити» (из alternatives) и «Видалити» — PATCH /me/plan/{id}, ответ — новый план. */
function PlanEditor({ initial }: { initial: UserPlan }) {
  const { t, locale } = useT();
  const { api } = useHost();
  const [plan, setPlan] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Message>(null);
  const apply = async (change: PlanChange, done: string) => {
    setBusy(true);
    setStatus(null);
    try {
      setPlan(await api.updatePlan(plan.id, change));
      setStatus({ text: done, alert: false });
    } catch {
      setStatus({ text: t("miniapp.plan.changeError"), alert: true });
    } finally {
      setBusy(false);
    }
  };
  const nameOf = (item: PlanItem) =>
    item.place ? pickLocalized(item.place.name, locale) : t("miniapp.plan.unavailable");
  return (
    <Stack>
      <h1>{pickLocalized(plan.title, locale)}</h1>
      {plan.scenarioUpdated && <p>{t("miniapp.plan.scenarioUpdated")}</p>}
      <Link to="/plan/saved" style={{ fontSize: "1.2rem", fontWeight: 700 }}>
        {t("miniapp.plan.backToList")}
      </Link>
      <Live message={status} testId="plan-status" />
      <Days
        days={plan.schedule}
        edit={{
          busy,
          onReplace: (item, p) =>
            void apply(
              { replace: { itemId: item.id, placeId: p.id } },
              t("miniapp.plan.replaced", { name: pickLocalized(p.name, locale) }),
            ),
          onRemove: (item) =>
            void apply({ remove: item.id }, t("miniapp.plan.removed", { name: nameOf(item) })),
        }}
      />
    </Stack>
  );
}

type Edit = {
  busy: boolean;
  onReplace: (item: PlanItem, place: PlanPlace) => void;
  onRemove: (item: PlanItem) => void;
};

function Days({ days, edit }: { days: PlanDay[]; edit?: Edit }) {
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
                <PlanItemRow key={i.id} item={i} edit={edit} />
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

function PlanItemRow({ item, edit }: { item: PlanItem; edit?: Edit }) {
  const { t, locale } = useT();
  const distance = useDistance();
  const [open, setOpen] = useState(false);
  const name = item.place ? pickLocalized(item.place.name, locale) : t("miniapp.plan.unavailable");
  const d = distance(item.distanceMeters);
  return (
    <li style={card} data-testid="plan-item">
      {item.time && <span style={{ fontWeight: 700, marginRight: 8 }}>{item.time}</span>}
      {item.place ? (
        <Link to={`/place/${item.place.id}`} style={{ fontSize: "1.2rem", fontWeight: 700 }}>
          {name}
        </Link>
      ) : (
        <strong data-testid="plan-item-unavailable">{name}</strong>
      )}
      {d && <span style={{ display: "block" }}>{t("miniapp.plan.distance", { n: d })}</span>}
      {item.note && <p style={{ margin: "4px 0" }}>{pickLocalized(item.note, locale)}</p>}
      {edit && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            <Button
              aria-expanded={open}
              aria-label={`${t("miniapp.plan.replace")}: ${name}`}
              disabled={edit.busy}
              onClick={() => setOpen((o) => !o)}
            >
              {t("miniapp.plan.replace")}
            </Button>
            <Button
              disabled={edit.busy}
              onClick={() => edit.onRemove(item)}
              aria-label={t("miniapp.plan.removeItem", { name })}
            >
              {t("miniapp.plan.remove")}
            </Button>
          </div>
          {open && (
            <div
              role="group"
              aria-label={t("miniapp.plan.alternatives", { name })}
              data-testid="alternatives"
            >
              {item.alternatives.length ? (
                <ul style={{ ...listStyle, marginTop: 8 }}>
                  {item.alternatives.map((a) => (
                    <li key={a.id}>
                      <Button
                        disabled={edit.busy}
                        onClick={() => {
                          setOpen(false);
                          edit.onReplace(item, a);
                        }}
                      >
                        {t("miniapp.plan.replaceWith", { name: pickLocalized(a.name, locale) })}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t("miniapp.plan.noAlternatives")}</p>
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
}
