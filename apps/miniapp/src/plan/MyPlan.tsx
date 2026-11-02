// C09 «Мій план»: готовые сценарии региона и сохранённые планы; сценарий по дням, замена пункта альтернативой,
// удаление пункта, «Зберегти як план» (UserPlan). Пункт → картка місця C06. Сохранение — только с сессией (C-24).
import { useState, type CSSProperties } from "react";
import { pickLocalized } from "@tg/i18n";
import { Button, Link, Stack, useRoute, useT } from "@tg/ui";
import { useAsync, useGuide } from "../guide/context.js";
import { AsyncView, Badge, card, listStyle } from "../guide/parts.js";
import { useHost } from "../host/context.js";
import type { PlanDay, PlanItem, PlanPlace, ScenarioSummary, UserPlan } from "../host/types.js";

const tabStyle = (active: boolean): CSSProperties => ({
  flex: 1,
  padding: "10px 12px",
  border: "1px solid var(--color-button)",
  borderRadius: "var(--radius)",
  background: active ? "var(--color-button)" : "var(--color-bg)",
  color: active ? "var(--color-button-text)" : "var(--color-text)",
  fontSize: "1rem",
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
      {(sc) => (
        <PlanEditor key={sc.id} title={sc.title} scenarioId={sc.id} initial={sc.schedule} planId={null} />
      )}
    </AsyncView>
  );
}

export function SavedPlanScreen({ id }: { id: string }) {
  const { api } = useHost();
  const [plan, retry] = useAsync(
    () =>
      api.plans().then((all) => {
        const p = all.find((x) => x.id === id);
        if (!p) throw new Error("not found");
        return p;
      }),
    [api, id],
  );
  return (
    <AsyncView state={plan} retry={retry}>
      {(p) => (
        <PlanEditor key={p.id} title={p.title} scenarioId={p.scenarioId} initial={p.schedule} planId={p.id} />
      )}
    </AsyncView>
  );
}

function replaceItem(days: PlanDay[], itemId: string, place: PlanPlace): PlanDay[] {
  return days.map((d) => ({
    ...d,
    items: d.items.map((i) =>
      i.id === itemId
        ? { ...i, place, alternatives: [i.place, ...i.alternatives.filter((a) => a.id !== place.id)] }
        : i,
    ),
  }));
}

function removeItem(days: PlanDay[], itemId: string): PlanDay[] {
  return days.map((d) => ({ ...d, items: d.items.filter((i) => i.id !== itemId) }));
}

function PlanEditor({
  title,
  scenarioId,
  initial,
  planId,
}: {
  title: ScenarioSummary["title"];
  scenarioId: string | null;
  initial: PlanDay[];
  planId: string | null;
}) {
  const { t, locale } = useT();
  const { signedIn } = useGuide();
  const { api } = useHost();
  const [days, setDays] = useState(initial);
  const [savedId, setSavedId] = useState(planId);
  const [status, setStatus] = useState<{ text: string; alert: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const plan = savedId
        ? await api.updatePlan(savedId, days)
        : await api.savePlan(scenarioId, title, days);
      setSavedId(plan.id);
      setStatus({ text: t("miniapp.plan.savedOk"), alert: false });
    } catch {
      setStatus({ text: t("miniapp.plan.saveError"), alert: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack>
      <h1>{pickLocalized(title, locale)}</h1>
      <Link to={planId ? "/plan/saved" : "/plan"}>{t("miniapp.plan.backToList")}</Link>
      {days.map((d) => (
        <section key={d.day} aria-labelledby={`day-${d.day}`} data-testid="plan-day">
          <h2 id={`day-${d.day}`} style={{ fontSize: "1.1rem" }}>
            {t("miniapp.plan.day", { n: d.day })}
          </h2>
          {d.items.length ? (
            <ol style={listStyle}>
              {d.items.map((i) => (
                <PlanItemRow
                  key={i.id}
                  item={i}
                  onReplace={(p) => {
                    setDays((ds) => replaceItem(ds, i.id, p));
                    setStatus({
                      text: t("miniapp.plan.replaced", { name: pickLocalized(p.name, locale) }),
                      alert: false,
                    });
                  }}
                  onRemove={() => {
                    setDays((ds) => removeItem(ds, i.id));
                    setStatus({
                      text: t("miniapp.plan.removed", { name: pickLocalized(i.place.name, locale) }),
                      alert: false,
                    });
                  }}
                />
              ))}
            </ol>
          ) : (
            <p>{t("miniapp.plan.dayEmpty")}</p>
          )}
        </section>
      ))}
      <p role={status?.alert ? "alert" : "status"} data-testid="plan-status">
        {status?.text ?? ""}
      </p>
      {signedIn ? (
        <Button onClick={() => void save()} disabled={busy} data-testid="plan-save">
          {t(savedId ? "miniapp.plan.saveChanges" : "miniapp.plan.save")}
        </Button>
      ) : (
        <p data-testid="plan-login">{t("miniapp.plan.needsLogin")}</p>
      )}
    </Stack>
  );
}

function PlanItemRow({
  item,
  onReplace,
  onRemove,
}: {
  item: PlanItem;
  onReplace: (p: PlanPlace) => void;
  onRemove: () => void;
}) {
  const { t, locale } = useT();
  const [open, setOpen] = useState(false);
  const name = pickLocalized(item.place.name, locale);
  return (
    <li style={card} data-testid="plan-item">
      {item.time && <span style={{ fontWeight: 700, marginRight: 8 }}>{item.time}</span>}
      <Link to={`/place/${item.place.id}`} style={{ fontSize: "1.1rem", fontWeight: 700 }}>
        {name}
      </Link>{" "}
      {item.place.adLabel && (
        <Badge>{t(item.place.adLabel === "partner" ? "miniapp.place.partner" : "miniapp.place.ad")}</Badge>
      )}
      {item.note && <p style={{ margin: "4px 0" }}>{pickLocalized(item.note, locale)}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <Button aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {t("miniapp.plan.replace")}
        </Button>
        <Button onClick={onRemove} aria-label={t("miniapp.plan.removeItem", { name })}>
          {t("miniapp.plan.remove")}
        </Button>
      </div>
      {open && (
        <div role="group" aria-label={t("miniapp.plan.alternatives", { name })} data-testid="alternatives">
          {item.alternatives.length ? (
            <ul style={{ ...listStyle, marginTop: 8 }}>
              {item.alternatives.map((a) => (
                <li key={a.id}>
                  <Button
                    onClick={() => {
                      setOpen(false);
                      onReplace(a);
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
    </li>
  );
}
