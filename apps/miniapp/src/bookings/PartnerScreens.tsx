// Кабинет партнёра, бронирования (блок 7, флаг module.bookings): P04 — брони по ресурсам на день и ручная запись;
// P05 — карточка брони с действиями (доступные переходы считает сервер по роли: allowedTransitions); ресурсы —
// создание и правка (version, 409 versionConflict → обновить), правила доступности по дням недели, ручной статус
// «Доступно зараз» с TTL. Телефон клиента — как отдаёт API (кассиру — нет). Экран грузится лениво.
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Link, Stack, useT } from "@tg/ui";
import { useAsync } from "../guide/context.js";
import { useBackStep, useScreenState } from "../screen-state.js";
import { AsyncView, Badge, card, listStyle } from "../guide/parts.js";
import { ConflictError } from "../host/types.js";
import { orgOfPlace, useKeptAsync, usePartner } from "../partner/context.js";
import type { PartnerOrganization } from "../partner/partner-api.js";
import { EmptyState, Live, PartnerHeader, type Message } from "../partner/parts.js";
import type {
  AvailabilityRule,
  ManualAvailability,
  PartnerBooking,
  PartnerResource,
  ResourcePatch,
  StatusChange,
} from "./bookings-api.js";
import { useBookings } from "./context.js";
import {
  addDays,
  bookingZone,
  dayLabel,
  localDate,
  localTime,
  normalizePhone,
  today,
  whenLabel,
  zonedIso,
} from "./format.js";
import { Reason, StatusBadge, useBookingErrorText, useIdempotencyKey } from "./parts.js";

const row = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } as const;

type Abilities = PartnerOrganization["abilities"];

/**
 * Права пользователя на место (abilities из /partner/me — сервер считает их по реестру прав, а не по коду роли);
 * null — место не из его назначений. undefined — /partner/me грузится.
 */
function usePlaceAbilities(placeId: string): Abilities | null | undefined {
  const { me } = usePartner();
  if (me.status !== "ready") return me.status === "loading" ? undefined : null;
  return orgOfPlace(me.data.organizations, placeId)?.abilities ?? null;
}

function useAccessGate(placeId: string): { abilities: Abilities | null; gate: ReactNode | null } {
  const { t } = useT();
  const abilities = usePlaceAbilities(placeId);
  if (abilities === undefined)
    return {
      abilities: null,
      gate: (
        <p role="status" className="kosiv-muted">
          {t("miniapp.guide.loading")}
        </p>
      ),
    };
  if (!abilities?.bookings)
    return { abilities: null, gate: <p role="alert">{t("miniapp.pbooking.noAccess")}</p> };
  return { abilities, gate: null };
}

// --- P04 ---

export function PartnerBookings({ placeId }: { placeId: string }) {
  const { t, locale } = useT();
  const { api, timeZone } = useBookings();
  const { abilities, gate } = useAccessGate(placeId);
  const [day, setDay] = useScreenState("pbooking.day", () => today(timeZone));
  const [resourceId, setResourceId] = useScreenState("pbooking.resource", "");
  const [openId, setOpenId] = useScreenState<string | null>("pbooking.open", null);
  const [adding, setAdding] = useState(false);
  // Деталь брони и форма — внутри экрана: «Назад» закрывает их, а не уходит из брони.
  useBackStep(openId !== null || adding, () => {
    setOpenId(null);
    setAdding(false);
  });
  const [notice, setNotice] = useState<Message>(null);
  const ids = { day: useId(), resource: useId() };
  const [resources, reloadResources] = useKeptAsync(() => api.partnerResources(placeId), [api, placeId]);
  const [bookings, reloadBookings, refreshError] = useKeptAsync(
    () =>
      api.partnerBookings(
        placeId,
        zonedIso(day, "00:00", timeZone),
        zonedIso(addDays(day, 1), "00:00", timeZone),
      ),
    [api, placeId, day, timeZone],
  );
  // Брони из сохранённого открытого пункта больше нет в списке — без фантомного шага «Назад».
  const openGone =
    openId !== null && bookings.status === "ready" && !bookings.data.some((b) => b.id === openId);
  useEffect(() => {
    if (openGone) setOpenId(null);
  }, [openGone, setOpenId]);
  if (gate || !abilities) return gate;
  const manage = abilities.manageResources;
  const open = openId && bookings.status === "ready" ? bookings.data.find((b) => b.id === openId) : undefined;
  if (open && resources.status === "ready")
    return (
      <BookingCard
        booking={open}
        abilities={abilities}
        onBack={() => setOpenId(null)}
        onChanged={() => reloadBookings()}
      />
    );
  return (
    <Stack>
      <PartnerHeader title={t("miniapp.pbooking.title")} />
      <Live message={notice} testId="pbooking-notice" />
      <AsyncView state={resources} retry={reloadResources} errorText={t("miniapp.pbooking.loadError")}>
        {(list) => {
          const active = list.filter((r) => r.status !== "archived");
          if (!active.length)
            return (
              <EmptyState
                testId="no-resources"
                icon="📅"
                text={t("miniapp.pbooking.noResources")}
                action={
                  manage && (
                    <Link to={`/partner/place/${placeId}/resources`} className="kosiv-cta">
                      {t("miniapp.pbooking.resourcesLink")}
                    </Link>
                  )
                }
              />
            );
          const shown = active.filter((r) => !resourceId || r.id === resourceId);
          return (
            <>
              <div style={row}>
                <Button
                  aria-label={t("miniapp.pbooking.prevDay")}
                  onClick={() => setDay((d) => addDays(d, -1))}
                >
                  ‹
                </Button>
                <label htmlFor={ids.day}>
                  <span className="pc-sr">{t("miniapp.pbooking.day")}</span>
                  <input
                    id={ids.day}
                    type="date"
                    value={day}
                    onChange={(e) => e.target.value && setDay(e.target.value)}
                  />
                </label>
                <Button
                  aria-label={t("miniapp.pbooking.nextDay")}
                  onClick={() => setDay((d) => addDays(d, 1))}
                >
                  ›
                </Button>
              </div>
              <p data-testid="pbooking-day">{dayLabel(day, locale)}</p>
              {active.length > 1 && (
                <label htmlFor={ids.resource}>
                  {t("miniapp.booking.resource")}
                  <select
                    id={ids.resource}
                    value={resourceId}
                    onChange={(e) => setResourceId(e.target.value)}
                  >
                    <option value="">{t("miniapp.pbooking.allResources")}</option>
                    {active.map((r) => (
                      <option key={r.id} value={r.id}>
                        {pickLocalized(r.name, locale)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {adding ? (
                <ManualBookingForm
                  resources={active.filter((r) => r.status === "active")}
                  day={day}
                  defaultResourceId={resourceId}
                  onCancel={() => setAdding(false)}
                  onDone={(b) => {
                    setAdding(false);
                    setNotice({ text: t("miniapp.pbooking.manualAdded"), alert: false });
                    setDay(localDate(b.startsAt, timeZone));
                    reloadBookings();
                  }}
                />
              ) : (
                abilities.manualBooking && (
                  <Button onClick={() => setAdding(true)} data-testid="manual-add">
                    {t("miniapp.pbooking.addManual")}
                  </Button>
                )
              )}
              {refreshError ? <p role="alert">{t("miniapp.partner.refreshError")}</p> : null}
              <AsyncView state={bookings} retry={reloadBookings} errorText={t("miniapp.pbooking.loadError")}>
                {(items) => (
                  <>
                    {shown.map((r) => {
                      const own = items
                        .filter((b) => b.resourceId === r.id)
                        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
                      return (
                        <section key={r.id} style={card} data-testid="pbooking-resource">
                          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{pickLocalized(r.name, locale)}</h2>
                          {own.length === 0 ? (
                            <p className="kosiv-muted">{t("miniapp.pbooking.emptyDay")}</p>
                          ) : (
                            <ul style={{ ...listStyle, gap: 6 }}>
                              {own.map((b) => (
                                <li key={b.id}>
                                  <button
                                    type="button"
                                    className="kosiv-toggle"
                                    style={{ width: "100%", justifyContent: "space-between", gap: 8 }}
                                    onClick={() => setOpenId(b.id)}
                                    data-testid="pbooking-row"
                                  >
                                    <span>
                                      {localTime(b.startsAt, timeZone)}–{localTime(b.endsAt, timeZone)} ·{" "}
                                      {b.customerName ?? t("miniapp.pbooking.noName")} ·{" "}
                                      {t("miniapp.booking.peopleCount", { n: b.peopleCount })}
                                    </span>
                                    <StatusBadge status={b.status} who="partner" />
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </section>
                      );
                    })}
                  </>
                )}
              </AsyncView>
              <Link to={`/partner/place/${placeId}/resources`}>{t("miniapp.pbooking.resourcesLink")}</Link>
            </>
          );
        }}
      </AsyncView>
    </Stack>
  );
}

function ManualBookingForm({
  resources,
  day,
  defaultResourceId,
  onCancel,
  onDone,
}: {
  resources: PartnerResource[];
  day: string;
  defaultResourceId: string;
  onCancel: () => void;
  onDone: (b: PartnerBooking) => void;
}) {
  const { t, locale } = useT();
  const { api, timeZone } = useBookings();
  const errorText = useBookingErrorText();
  const idem = useIdempotencyKey();
  const [d, setD] = useState({
    resourceId: resources.some((r) => r.id === defaultResourceId)
      ? defaultResourceId
      : (resources[0]?.id ?? ""),
    date: day,
    time: "",
    people: "1",
    name: "",
    phone: "",
    comment: "",
    source: "manual" as "manual" | "phone",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const ids = {
    resource: useId(),
    date: useId(),
    time: useId(),
    people: useId(),
    name: useId(),
    phone: useId(),
    comment: useId(),
    source: useId(),
  };
  const set = (k: keyof typeof d) => (e: { target: { value: string } }) =>
    setD((x) => ({ ...x, [k]: e.target.value }));
  if (!resources.length) return <p role="alert">{t("errors.booking.resourceInactive")}</p>;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const phone = d.phone.trim() ? normalizePhone(d.phone) : null;
    if (!d.name.trim()) return setMessage({ text: t("errors.booking.customerNameRequired"), alert: true });
    if (!/^\d{2}:\d{2}$/.test(d.time))
      return setMessage({ text: t("miniapp.pbooking.timeRequired"), alert: true });
    if (d.phone.trim() && !phone) return setMessage({ text: t("miniapp.booking.phoneInvalid"), alert: true });
    const body = {
      resourceId: d.resourceId,
      startsAt: zonedIso(d.date, d.time, timeZone),
      peopleCount: Math.max(1, Math.trunc(Number(d.people)) || 1),
      customerName: d.name.trim(),
      ...(phone ? { customerPhone: phone } : {}),
      ...(d.comment.trim() ? { comment: d.comment.trim() } : {}),
      source: d.source,
    };
    setBusy(true);
    setMessage(null);
    try {
      const created = await api.createManual(body, idem.keyFor(body));
      idem.settle();
      onDone(created);
    } catch (err) {
      idem.settle(err);
      setMessage({ text: errorText(err, "miniapp.pbooking.manualError"), alert: true });
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} style={card} data-testid="manual-form">
      <Stack>
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{t("miniapp.pbooking.addManual")}</h2>
        {resources.length > 1 && (
          <label htmlFor={ids.resource}>
            {t("miniapp.booking.resource")}
            <select id={ids.resource} value={d.resourceId} onChange={set("resourceId")}>
              {resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {pickLocalized(r.name, locale)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div style={row}>
          <label htmlFor={ids.date}>
            {t("miniapp.booking.date")}
            <input id={ids.date} type="date" value={d.date} onChange={set("date")} required />
          </label>
          <label htmlFor={ids.time}>
            {t("miniapp.pbooking.time")}
            <input id={ids.time} type="time" value={d.time} onChange={set("time")} required />
          </label>
          <label htmlFor={ids.people}>
            {t("miniapp.pbooking.people")}
            <input
              id={ids.people}
              type="number"
              min={1}
              max={100}
              value={d.people}
              onChange={set("people")}
              style={{ width: 90 }}
            />
          </label>
        </div>
        <label htmlFor={ids.name}>
          {t("miniapp.pbooking.customerName")}
          <input id={ids.name} value={d.name} maxLength={200} onChange={set("name")} required />
        </label>
        <label htmlFor={ids.phone}>
          {t("miniapp.pbooking.customerPhone")}
          <input id={ids.phone} type="tel" value={d.phone} onChange={set("phone")} placeholder="+380…" />
        </label>
        {d.phone.trim() && normalizePhone(d.phone) && normalizePhone(d.phone) !== d.phone.trim() && (
          <p className="kosiv-muted" data-testid="manual-phone-normalized">
            {t("miniapp.booking.phoneWillBe", { phone: normalizePhone(d.phone)! })}
          </p>
        )}
        <label htmlFor={ids.source}>
          {t("miniapp.pbooking.source")}
          <select id={ids.source} value={d.source} onChange={set("source")}>
            <option value="manual">{t("miniapp.pbooking.source.manual")}</option>
            <option value="phone">{t("miniapp.pbooking.source.phone")}</option>
          </select>
        </label>
        <label htmlFor={ids.comment}>
          {t("miniapp.booking.comment")}
          <textarea id={ids.comment} rows={2} maxLength={500} value={d.comment} onChange={set("comment")} />
        </label>
        <Live message={message} testId="manual-message" />
        <span style={row}>
          <Button type="submit" disabled={busy}>
            {t("miniapp.pbooking.manualSave")}
          </Button>
          <Button type="button" onClick={onCancel} disabled={busy}>
            {t("miniapp.pbooking.cancelForm")}
          </Button>
        </span>
      </Stack>
    </form>
  );
}

// --- P05 ---

const ACTION_KEYS: Record<string, MessageKey> = {
  confirmed: "miniapp.pbooking.action.confirm",
  completed: "miniapp.pbooking.action.completed",
  no_show: "miniapp.pbooking.action.noShow",
};

function BookingCard({
  booking: b,
  abilities,
  onBack,
  onChanged,
}: {
  booking: PartnerBooking;
  abilities: Abilities;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { t, locale } = useT();
  const { api, timeZone: envZone } = useBookings();
  // Время брони — в поясе её места (сервер).
  const timeZone = bookingZone(b.timezone, envZone);
  const errorText = useBookingErrorText();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [stale, setStale] = useState(false);
  const [mode, setMode] = useState<"reject" | "alternative" | null>(null);
  const [reason, setReason] = useState("");
  const [alt, setAlt] = useState({ date: localDate(b.startsAt, timeZone), time: "" });
  const ids = { reason: useId(), altDate: useId(), altTime: useId() };
  const can = (s: string) => (b.allowedTransitions as string[]).includes(s);

  const change = async (c: StatusChange) => {
    setBusy(true);
    setMessage(null);
    setStale(false);
    try {
      await api.setStatus(b.id, b.regionId, c);
      setMode(null);
      setReason("");
      setMessage({ text: t("miniapp.pbooking.saved"), alert: false });
      onChanged();
    } catch (e) {
      setMessage({ text: errorText(e, "miniapp.booking.actionError"), alert: true });
      // Статус уже сменился (другой сотрудник, воркер по SLA) — предложить обновить.
      if (
        e instanceof ConflictError &&
        (e.messageKey === "errors.booking.invalidTransition" ||
          e.messageKey === "errors.booking.responseOverdue")
      )
        setStale(true);
    }
    setBusy(false);
  };

  const sourceKey = `miniapp.pbooking.source.${b.source}` as MessageKey;
  return (
    <Stack>
      <h1>{t("miniapp.pbooking.cardTitle")}</h1>
      <Button onClick={onBack}>{t("miniapp.pbooking.back")}</Button>
      <section style={card} data-testid="pbooking-card">
        <StatusBadge status={b.status} who="partner" />
        <Reason reason={b.statusReason} code={b.statusReasonCode} />
        <dl>
          <dt>{t("miniapp.booking.resource")}</dt>
          <dd>{pickLocalized(b.resourceName, locale)}</dd>
          <dt>{t("miniapp.booking.when")}</dt>
          <dd>
            {whenLabel(b.startsAt, timeZone, locale)}–{localTime(b.endsAt, timeZone)}
          </dd>
          <dt>{t("miniapp.pbooking.people")}</dt>
          <dd>{b.peopleCount}</dd>
          <dt>{t("miniapp.pbooking.customerName")}</dt>
          <dd>{b.customerName ?? t("miniapp.pbooking.noName")}</dd>
          <dt>{t("miniapp.pbooking.customerPhone")}</dt>
          <dd data-testid="pbooking-phone">
            {b.contactPhone ? (
              <a href={`tel:${b.contactPhone}`}>{b.contactPhone}</a>
            ) : (
              t(abilities.customerPhone ? "miniapp.pbooking.phoneNone" : "miniapp.pbooking.phoneHidden")
            )}
          </dd>
          <dt>{t("miniapp.pbooking.source")}</dt>
          <dd>{t(sourceKey)}</dd>
          {b.comment && (
            <>
              <dt>{t("miniapp.booking.comment")}</dt>
              <dd style={{ whiteSpace: "pre-line" }}>{b.comment}</dd>
            </>
          )}
        </dl>
        {b.status === "pending_partner" && b.partnerResponseDueAt && (
          <p data-testid="pbooking-due">
            {t("miniapp.pbooking.respondUntil", {
              time: whenLabel(b.partnerResponseDueAt, timeZone, locale),
            })}
          </p>
        )}
        {b.alternative && (
          <p data-testid="pbooking-alternative">
            {t("miniapp.pbooking.alternativeSent", {
              time: whenLabel(b.alternative.startsAt, timeZone, locale),
              until: whenLabel(b.alternative.respondBy, timeZone, locale),
            })}
          </p>
        )}
      </section>
      <Live message={message} testId="pbooking-message" />
      {stale && <Button onClick={onChanged}>{t("miniapp.pbooking.refresh")}</Button>}
      <div style={row} data-testid="pbooking-actions">
        {Object.entries(ACTION_KEYS)
          .filter(([s]) => can(s))
          .map(([s, key]) => (
            <Button
              key={s}
              disabled={busy}
              onClick={() => void change({ status: s as StatusChange["status"] })}
            >
              {t(key)}
            </Button>
          ))}
        {can("alternative_proposed") && (
          <Button
            disabled={busy}
            aria-expanded={mode === "alternative"}
            onClick={() => setMode("alternative")}
          >
            {t("miniapp.pbooking.action.alternative")}
          </Button>
        )}
        {can("cancelled_by_partner") && (
          <Button disabled={busy} aria-expanded={mode === "reject"} onClick={() => setMode("reject")}>
            {t(
              b.status === "alternative_proposed"
                ? "miniapp.pbooking.action.withdraw"
                : "miniapp.pbooking.action.reject",
            )}
          </Button>
        )}
      </div>
      {mode === "reject" && (
        <form
          style={card}
          onSubmit={(e) => {
            e.preventDefault();
            if (!reason.trim()) return setMessage({ text: t("errors.booking.reasonRequired"), alert: true });
            void change({ status: "cancelled_by_partner", reason: reason.trim() });
          }}
        >
          <Stack>
            <label htmlFor={ids.reason}>
              {t("miniapp.pbooking.reason")}
              <textarea
                id={ids.reason}
                rows={2}
                maxLength={500}
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <span style={row}>
              <Button type="submit" disabled={busy}>
                {t("miniapp.pbooking.rejectSend")}
              </Button>
              <Button type="button" onClick={() => setMode(null)}>
                {t("miniapp.pbooking.cancelForm")}
              </Button>
            </span>
          </Stack>
        </form>
      )}
      {mode === "alternative" && (
        <AlternativeForm
          booking={b}
          value={alt}
          onChange={setAlt}
          busy={busy}
          ids={{ date: ids.altDate, time: ids.altTime }}
          onCancel={() => setMode(null)}
          onSubmit={(iso) => void change({ status: "alternative_proposed", alternativeStartsAt: iso })}
        />
      )}
      {b.history.length > 0 && (
        <section>
          <h2 style={{ fontSize: "1.05rem" }}>{t("miniapp.pbooking.history")}</h2>
          <ul style={{ ...listStyle, gap: 4 }} data-testid="pbooking-history">
            {b.history.map((h, i) => (
              <li key={i} className="kosiv-muted">
                {whenLabel(h.at, timeZone, locale)} —{" "}
                {t(`miniapp.booking.pstatus.${h.toStatus}` as MessageKey)}
                <Reason reason={h.reason} code={h.reasonCode} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </Stack>
  );
}

function AlternativeForm({
  booking,
  value,
  onChange,
  busy,
  ids,
  onCancel,
  onSubmit,
}: {
  booking: PartnerBooking;
  value: { date: string; time: string };
  onChange: (v: { date: string; time: string }) => void;
  busy: boolean;
  ids: { date: string; time: string };
  onCancel: () => void;
  onSubmit: (iso: string) => void;
}) {
  const { t } = useT();
  const { api, timeZone: envZone } = useBookings();
  const timeZone = bookingZone(booking.timezone, envZone);
  // Свободные слоты ресурса на выбранную дату — сетка партнёра (есть и у неопубликованного места); ошибка — только
  // ручной ввод времени.
  const [slots] = useAsync(
    () => api.partnerSlots(booking.resourceId, value.date, 1),
    [api, booking.resourceId, value.date],
  );
  const free = slots.status === "ready" ? slots.data.items.filter((s) => s.free) : [];
  return (
    <form
      style={card}
      data-testid="alternative-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (/^\d{2}:\d{2}$/.test(value.time)) onSubmit(zonedIso(value.date, value.time, timeZone));
      }}
    >
      <Stack>
        <div style={row}>
          <label htmlFor={ids.date}>
            {t("miniapp.booking.date")}
            <input
              id={ids.date}
              type="date"
              value={value.date}
              required
              onChange={(e) => onChange({ date: e.target.value, time: "" })}
            />
          </label>
          <label htmlFor={ids.time}>
            {t("miniapp.pbooking.time")}
            <input
              id={ids.time}
              type="time"
              value={value.time}
              required
              onChange={(e) => onChange({ ...value, time: e.target.value })}
            />
          </label>
        </div>
        {free.length > 0 && (
          <div role="group" aria-label={t("miniapp.pbooking.freeSlots")} style={row}>
            {free.map((s) => {
              const time = localTime(s.startsAt, timeZone);
              return (
                <button
                  key={s.startsAt}
                  type="button"
                  className="kosiv-toggle"
                  aria-pressed={value.time === time}
                  onClick={() => onChange({ ...value, time })}
                >
                  {time}
                </button>
              );
            })}
          </div>
        )}
        <span style={row}>
          <Button type="submit" disabled={busy || !value.time}>
            {t("miniapp.pbooking.alternativeSend")}
          </Button>
          <Button type="button" onClick={onCancel}>
            {t("miniapp.pbooking.cancelForm")}
          </Button>
        </span>
      </Stack>
    </form>
  );
}

// --- ресурсы ---

export function PartnerResources({ placeId }: { placeId: string }) {
  const { t, locale } = useT();
  const { api } = useBookings();
  const { abilities, gate } = useAccessGate(placeId);
  const [state, reload] = useKeptAsync(() => api.partnerResources(placeId), [api, placeId]);
  // fresh — только что созданный ресурс: шаг 2 создания (расписание) открывается сразу, до перечитывания списка.
  const [editing, setEditing] = useState<{
    id: string | null;
    part: "settings" | "rules";
    fresh?: PartnerResource;
  } | null>(null);
  const close = () => {
    if (editing?.fresh) reload();
    setEditing(null);
  };
  useBackStep(editing !== null, close);
  const [notice, setNotice] = useState<Message>(null);
  if (gate || !abilities) return gate;
  const manage = abilities.manageResources;
  const done = (text: string) => {
    setEditing(null);
    setNotice({ text, alert: false });
    reload();
  };
  const fresh = editing?.part === "rules" ? editing.fresh : undefined;
  return (
    <Stack>
      <PartnerHeader
        title={t("miniapp.pres.title")}
        backTo={`/partner/place/${placeId}/bookings`}
        backLabel={`← ${t("miniapp.pres.toBookings")}`}
      />
      <Live message={notice} testId="pres-notice" />
      <AsyncView state={state} retry={reload} errorText={t("miniapp.pbooking.loadError")}>
        {(items) => (
          <>
            {items.length === 0 && (
              <EmptyState icon="📅" text={t("miniapp.pbooking.noResources")} testId="resources-empty" />
            )}
            <ul style={listStyle} data-testid="resources">
              {items.map((r) => (
                <li key={r.id} style={card} data-testid="resource">
                  <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{pickLocalized(r.name, locale)}</h2>
                  <span style={row}>
                    <Badge testId="resource-status">
                      {t(`miniapp.pres.status.${r.status}` as MessageKey)}
                    </Badge>
                    <span className="kosiv-muted">
                      {t("miniapp.pres.summary", {
                        people: r.capacityPeople,
                        minutes: r.slotDurationMin,
                      })}
                    </span>
                  </span>
                  {editing?.id === r.id && editing.part === "settings" ? (
                    <ResourceForm
                      placeId={placeId}
                      resource={r}
                      onCancel={() => setEditing(null)}
                      onDone={() => done(t("miniapp.pres.saved"))}
                      onRefresh={() => {
                        setEditing(null);
                        reload();
                      }}
                    />
                  ) : editing?.id === r.id && editing.part === "rules" ? (
                    <RulesEditor
                      resource={r}
                      onCancel={() => setEditing(null)}
                      onDone={() => done(t("miniapp.pres.rulesSaved"))}
                    />
                  ) : (
                    <>
                      {/* Без открытых окон слотов нет — туристу ресурс не показывается (GET /resources). */}
                      {!hasOpenRules(r.rules) && (
                        <div role="note" style={warning} data-testid="resource-no-rules">
                          <p style={{ margin: 0 }}>⚠️ {t("miniapp.pres.noRules")}</p>
                          {abilities.editAvailability && (
                            <Button onClick={() => setEditing({ id: r.id, part: "rules" })}>
                              {t("miniapp.pres.setRules")}
                            </Button>
                          )}
                        </div>
                      )}
                      {abilities.manualAvailability && <ManualStatus resource={r} onDone={reload} />}
                      {(manage || abilities.editAvailability) && (
                        <span style={row}>
                          {manage && (
                            <Button onClick={() => setEditing({ id: r.id, part: "settings" })}>
                              {t("miniapp.pres.edit")}
                            </Button>
                          )}
                          {abilities.editAvailability && (
                            <Button onClick={() => setEditing({ id: r.id, part: "rules" })}>
                              {t("miniapp.pres.rules")}
                            </Button>
                          )}
                        </span>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
            {fresh ? (
              <div style={card} data-testid="resource-step2">
                <h2 style={{ margin: 0, fontSize: "1.1rem" }}>
                  {t("miniapp.pres.step2", { name: pickLocalized(fresh.name, locale) })}
                </h2>
                <RulesEditor
                  resource={fresh}
                  onCancel={close}
                  onDone={() => done(t("miniapp.pres.rulesSaved"))}
                />
              </div>
            ) : (
              manage &&
              (editing?.id === null ? (
                <ResourceForm
                  placeId={placeId}
                  resource={null}
                  onCancel={() => setEditing(null)}
                  onDone={(created) => {
                    // Шаг 2: без расписания у ресурса нет слотов — туристы его не увидят.
                    setNotice({ text: t("miniapp.pres.created"), alert: false });
                    if (abilities.editAvailability)
                      setEditing({ id: created.id, part: "rules", fresh: created });
                    else {
                      setEditing(null);
                      reload();
                    }
                  }}
                  onRefresh={reload}
                />
              ) : (
                <Button onClick={() => setEditing({ id: null, part: "settings" })} data-testid="resource-new">
                  {t("miniapp.pres.new")}
                </Button>
              ))
            )}
          </>
        )}
      </AsyncView>
    </Stack>
  );
}

const warning = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  alignItems: "center",
  padding: "8px 12px",
  borderRadius: 8,
  // Токены сезона/темы (index.html) — читается и в ночной теме.
  background: "var(--app-pill-bg)",
  border: "1px solid var(--app-accent-2)",
} as const;

/** Есть хотя бы одно открытое окно (недельное или на дату) — иначе слотов нет. */
export function hasOpenRules(rules: PartnerResource["rules"]): boolean {
  return rules.some((r) => !r.closed && Boolean(r.opensAt) && Boolean(r.closesAt));
}

const NUMBER_FIELDS = [
  ["capacityPeople", 1, 100],
  ["slotDurationMin", 15, 720],
  ["bufferBeforeMin", 0, 240],
  ["bufferAfterMin", 0, 240],
  ["leadTimeMin", 0, 10080],
  ["horizonDays", 1, 365],
  ["confirmSlaMin", 5, 1440],
] as const;
type NumberField = (typeof NUMBER_FIELDS)[number][0];

const DEFAULTS: Record<NumberField, number> = {
  capacityPeople: 4,
  slotDurationMin: 60,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  leadTimeMin: 60,
  horizonDays: 30,
  confirmSlaMin: 30,
};

function ResourceForm({
  placeId,
  resource,
  onCancel,
  onDone,
  onRefresh,
}: {
  placeId: string;
  resource: PartnerResource | null;
  onCancel: () => void;
  onDone: (saved: PartnerResource) => void;
  /** Ресурс изменили после чтения (409 versionConflict) — перечитать. */
  onRefresh: () => void;
}) {
  const { t } = useT();
  const { api } = useBookings();
  const errorText = useBookingErrorText();
  const formId = useId();
  const [name, setName] = useState(resource?.name.uk ?? "");
  const [description, setDescription] = useState(resource?.description?.uk ?? "");
  const [nums, setNums] = useState<Record<NumberField, string>>(
    () =>
      Object.fromEntries(
        NUMBER_FIELDS.map(([f]) => [f, String(resource ? resource[f] : DEFAULTS[f])]),
      ) as Record<NumberField, string>,
  );
  const [mode, setMode] = useState(resource?.bookingMode ?? "request_confirm");
  const [price, setPrice] = useState(
    resource?.priceMinor !== null && resource?.priceMinor !== undefined
      ? String(resource.priceMinor / 100)
      : "",
  );
  const [status, setStatus] = useState(resource?.status ?? "active");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [conflict, setConflict] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setMessage({ text: t("miniapp.pres.nameRequired"), alert: true });
    const values = {} as Record<NumberField, number>;
    for (const [f, min, max] of NUMBER_FIELDS) {
      const n = Number(nums[f]);
      if (!Number.isInteger(n) || n < min || n > max)
        return setMessage({
          text: t("miniapp.pres.range", { field: t(`miniapp.pres.field.${f}` as MessageKey), min, max }),
          alert: true,
        });
      values[f] = n;
    }
    const priceNum = price.trim() ? Number(price.replace(",", ".")) : null;
    if (priceNum !== null && (!Number.isFinite(priceNum) || priceNum < 0))
      return setMessage({ text: t("miniapp.pres.priceInvalid"), alert: true });
    const settings = {
      ...values,
      // Правка только uk: остальные языки (en) не затираются.
      description: description.trim() ? { ...resource?.description, uk: description.trim() } : null,
      bookingMode: mode,
      priceMinor: priceNum === null ? null : Math.round(priceNum * 100),
      currency: priceNum === null ? null : (resource?.currency ?? "UAH"),
    };
    setBusy(true);
    setMessage(null);
    setConflict(false);
    try {
      let saved: PartnerResource;
      if (resource) {
        const patch: ResourcePatch = {
          ...settings,
          name: { ...resource.name, uk: name.trim() },
          status,
          version: resource.version,
        };
        saved = await api.updateResource(resource.id, patch);
      } else saved = await api.createResource({ ...settings, placeId, name: { uk: name.trim() } });
      onDone(saved);
    } catch (err) {
      setBusy(false);
      if (err instanceof ConflictError && err.messageKey === "errors.resource.versionConflict") {
        setConflict(true);
        setMessage({ text: t("errors.resource.versionConflict"), alert: true });
        return;
      }
      setMessage({ text: errorText(err, "miniapp.pres.saveError"), alert: true });
    }
  };
  const field = (f: NumberField, min: number, max: number) => (
    <label key={f} htmlFor={`${formId}-${f}`}>
      {t(`miniapp.pres.field.${f}` as MessageKey)}
      <input
        id={`${formId}-${f}`}
        type="number"
        min={min}
        max={max}
        value={nums[f]}
        style={{ width: 120 }}
        onChange={(e) => setNums((x) => ({ ...x, [f]: e.target.value }))}
      />
    </label>
  );
  return (
    <form onSubmit={(e) => void save(e)} data-testid="resource-form">
      <Stack>
        <label htmlFor={`${formId}-name`}>
          {t("miniapp.pres.name")}
          <input
            id={`${formId}-name`}
            value={name}
            maxLength={200}
            required
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label htmlFor={`${formId}-desc`}>
          {t("miniapp.pres.description")}
          <textarea
            id={`${formId}-desc`}
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div style={row}>{NUMBER_FIELDS.map(([f, min, max]) => field(f, min, max))}</div>
        <HorizonHint value={nums.horizonDays} />
        <label htmlFor={`${formId}-mode`}>
          {t("miniapp.pres.mode")}
          <select id={`${formId}-mode`} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="request_confirm">{t("miniapp.pres.mode.request_confirm")}</option>
            <option value="auto_confirm">{t("miniapp.pres.mode.auto_confirm")}</option>
          </select>
        </label>
        <label htmlFor={`${formId}-price`}>
          {t("miniapp.pres.price")}
          <input
            id={`${formId}-price`}
            inputMode="decimal"
            value={price}
            style={{ width: 120 }}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        {resource && (
          <label htmlFor={`${formId}-status`}>
            {t("miniapp.pres.statusLabel")}
            <select
              id={`${formId}-status`}
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              {(["active", "inactive", "archived"] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`miniapp.pres.status.${s}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        <Live message={message} testId="resource-message" />
        {conflict && (
          <Button type="button" onClick={onRefresh} data-testid="resource-refresh">
            {t("miniapp.pbooking.refresh")}
          </Button>
        )}
        <span style={row}>
          <Button type="submit" disabled={busy}>
            {t(resource ? "miniapp.pres.save" : "miniapp.pres.create")}
          </Button>
          <Button type="button" onClick={onCancel}>
            {t("miniapp.pbooking.cancelForm")}
          </Button>
        </span>
      </Stack>
    </form>
  );
}

/** Подсказка к «Бронювати наперед»: туристы видят слоты только на столько дней вперёд. */
function HorizonHint({ value }: { value: string }) {
  const { t } = useT();
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 365) return null;
  return (
    <p className="kosiv-muted" data-testid="horizon-hint" style={{ margin: 0 }}>
      {t("miniapp.pres.horizonHint", { days })}
      {days < 7 && ` ${t("miniapp.pres.horizonShort")}`}
    </p>
  );
}

type Window = { opensAt: string; closesAt: string };

/** Расписание по умолчанию, если у места нет часов работы: каждый день 10:00–21:00. */
export const DEFAULT_WINDOW: Window = { opensAt: "10:00", closesAt: "21:00" };

/**
 * Предлагаемые окна нового ресурса: часы работы места (weekly из графика), иначе каждый день DEFAULT_WINDOW.
 * Окно через полночь (закрытие не позже открытия) и «23:59» — до 24:00: правило ресурса не переходит через полночь.
 */
export function suggestedWeekly(hours: readonly { dayOfWeek: number; opensAt: string; closesAt: string }[]): {
  weekly: Record<number, Window[]>;
  fromPlace: boolean;
} {
  const out: Record<number, Window[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
  for (const h of hours) {
    const day = out[h.dayOfWeek];
    if (!day) continue;
    const opensAt = h.opensAt.slice(0, 5);
    let closesAt = h.closesAt.slice(0, 5);
    if (closesAt === "23:59" || closesAt <= opensAt) closesAt = "24:00";
    // Пересекающиеся окна сервер отклонит — берём только непересекающиеся.
    if (day.some((w) => opensAt < w.closesAt && w.opensAt < closesAt)) continue;
    day.push({ opensAt, closesAt });
  }
  const fromPlace = Object.values(out).some((d) => d.length > 0);
  if (!fromPlace) for (let d = 1; d <= 7; d++) out[d] = [{ ...DEFAULT_WINDOW }];
  for (const d of Object.values(out)) d.sort((a, b) => a.opensAt.localeCompare(b.opensAt));
  return { weekly: out, fromPlace };
}

/** Недельные окна ресурса по дням (1 — пн … 7 — нд); правила на даты сохраняются как есть. */
export function weeklyOf(rules: PartnerResource["rules"]): Record<number, Window[]> {
  const out: Record<number, Window[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
  for (const r of rules)
    if (r.dayOfWeek && !r.date && !r.closed && r.opensAt && r.closesAt)
      out[r.dayOfWeek]!.push({ opensAt: r.opensAt, closesAt: r.closesAt });
  for (const d of Object.values(out)) d.sort((a, b) => a.opensAt.localeCompare(b.opensAt));
  return out;
}

/** Окна → тело PUT: недельные + правила на даты без изменений. null — окно с закрытием не позже открытия. */
export function rulesBody(
  weekly: Record<number, Window[]>,
  rules: PartnerResource["rules"],
): AvailabilityRule[] | null {
  const out: AvailabilityRule[] = [];
  for (let day = 1; day <= 7; day++)
    for (const w of weekly[day] ?? []) {
      if (!(w.closesAt === "24:00" || w.opensAt < w.closesAt)) return null;
      out.push({ dayOfWeek: day, opensAt: w.opensAt, closesAt: w.closesAt });
    }
  for (const r of rules)
    if (r.date) out.push({ date: r.date, closed: r.closed, opensAt: r.opensAt, closesAt: r.closesAt });
  return out;
}

type EditorProps = { resource: PartnerResource; onCancel: () => void; onDone: () => void };

/**
 * Окна по дням. Ресурс без недельного расписания (новый или так и не настроенный) — сразу предложение: часы работы
 * места (GET /partner/places/{id}; нет доступа или графика — каждый день 10:00–21:00), партнёру остаётся сохранить.
 */
function RulesEditor(props: EditorProps) {
  const { t } = useT();
  const partner = usePartner();
  const empty = !props.resource.rules.some((r) => r.dayOfWeek && !r.date);
  const [hours] = useAsync(
    () =>
      empty
        ? Promise.resolve()
            .then(() => partner.api.place(props.resource.placeId))
            .then(
              (p) => p.schedule.weekly,
              () => [],
            )
        : Promise.resolve([]),
    [partner.api, props.resource.placeId, empty],
  );
  if (!empty) return <RulesForm {...props} />;
  if (hours.status === "loading")
    return (
      <p role="status" className="kosiv-muted">
        {t("miniapp.guide.loading")}
      </p>
    );
  const suggestion = suggestedWeekly(hours.status === "ready" ? hours.data : []);
  return (
    <RulesForm
      {...props}
      initial={suggestion.weekly}
      hint={t(suggestion.fromPlace ? "miniapp.pres.suggestedFromPlace" : "miniapp.pres.suggestedDefault")}
    />
  );
}

function RulesForm({
  resource,
  onCancel,
  onDone,
  initial,
  hint,
}: EditorProps & { initial?: Record<number, Window[]>; hint?: string }) {
  const { t } = useT();
  const { api } = useBookings();
  const errorText = useBookingErrorText();
  const formId = useId();
  const [weekly, setWeekly] = useState(() => initial ?? weeklyOf(resource.rules));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const dated = resource.rules.filter((r) => r.date).length;
  const update = (day: number, fn: (w: Window[]) => Window[]) =>
    setWeekly((x) => ({ ...x, [day]: fn(x[day] ?? []) }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = rulesBody(weekly, resource.rules);
    if (!body) return setMessage({ text: t("miniapp.pres.windowInvalid"), alert: true });
    setBusy(true);
    setMessage(null);
    try {
      await api.putAvailability(resource.id, body);
      onDone();
    } catch (err) {
      setBusy(false);
      setMessage({ text: errorText(err, "miniapp.pres.saveError"), alert: true });
    }
  };
  return (
    <form onSubmit={(e) => void save(e)} data-testid="rules-form">
      <Stack>
        {hint && (
          <p role="note" style={warning} data-testid="rules-suggested">
            {hint}
          </p>
        )}
        <p className="kosiv-muted">{t("miniapp.pres.rulesHint")}</p>
        {[1, 2, 3, 4, 5, 6, 7].map((day) => {
          const windows = weekly[day] ?? [];
          const dayName = t(`miniapp.weekday.${day}` as MessageKey);
          return (
            <fieldset key={day} data-testid="rules-day">
              <legend>{dayName}</legend>
              {windows.length === 0 && <p className="kosiv-muted">{t("miniapp.pres.dayClosed")}</p>}
              {windows.map((w, i) => (
                <div key={i} style={row}>
                  <label htmlFor={`${formId}-${day}-${i}-o`}>
                    {t("miniapp.pres.opens")}
                    <input
                      id={`${formId}-${day}-${i}-o`}
                      type="time"
                      value={w.opensAt}
                      required
                      onChange={(e) =>
                        update(day, (ws) =>
                          ws.map((x, j) => (j === i ? { ...x, opensAt: e.target.value } : x)),
                        )
                      }
                    />
                  </label>
                  <label htmlFor={`${formId}-${day}-${i}-c`}>
                    {t("miniapp.pres.closes")}
                    <input
                      id={`${formId}-${day}-${i}-c`}
                      type="time"
                      value={w.closesAt === "24:00" ? "" : w.closesAt}
                      disabled={w.closesAt === "24:00"}
                      required={w.closesAt !== "24:00"}
                      onChange={(e) =>
                        update(day, (ws) =>
                          ws.map((x, j) => (j === i ? { ...x, closesAt: e.target.value } : x)),
                        )
                      }
                    />
                  </label>
                  {/* «24:00» (до конца суток) <input type="time"> показать не может — отдельной галочкой. */}
                  <label htmlFor={`${formId}-${day}-${i}-m`}>
                    <input
                      id={`${formId}-${day}-${i}-m`}
                      type="checkbox"
                      checked={w.closesAt === "24:00"}
                      onChange={(e) =>
                        update(day, (ws) =>
                          ws.map((x, j) =>
                            j === i ? { ...x, closesAt: e.target.checked ? "24:00" : "23:00" } : x,
                          ),
                        )
                      }
                    />
                    {t("miniapp.pres.untilMidnight")}
                  </label>
                  <Button
                    type="button"
                    aria-label={t("miniapp.pres.removeWindow", { day: dayName })}
                    onClick={() => update(day, (ws) => ws.filter((_, j) => j !== i))}
                  >
                    ×
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                onClick={() => update(day, (ws) => [...ws, { opensAt: "10:00", closesAt: "18:00" }])}
              >
                {t("miniapp.pres.addWindow", { day: dayName })}
              </Button>
            </fieldset>
          );
        })}
        {dated > 0 && <p className="kosiv-muted">{t("miniapp.pres.datedKept", { n: dated })}</p>}
        <Live message={message} testId="rules-message" />
        <span style={row}>
          <Button type="submit" disabled={busy}>
            {t("miniapp.pres.rulesSave")}
          </Button>
          <Button type="button" onClick={onCancel}>
            {t("miniapp.pbooking.cancelForm")}
          </Button>
        </span>
      </Stack>
    </form>
  );
}

const TTL_OPTIONS = [15, 30, 60, 120, 240] as const;

function ManualStatus({ resource: r, onDone }: { resource: PartnerResource; onDone: () => void }) {
  const { t } = useT();
  const { api, timeZone } = useBookings();
  const errorText = useBookingErrorText();
  const ttlId = useId();
  const [ttl, setTtl] = useState(60);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const until = r.availability.manualExpiresAt;
  const current: ManualAvailability = until ? r.manualAvailability : "unknown";
  const put = async (status: ManualAvailability) => {
    setBusy(true);
    setMessage(null);
    try {
      await api.putManual(r.id, status, status === "unknown" ? undefined : ttl);
      setMessage({ text: t("miniapp.pres.manualSaved"), alert: false });
      onDone();
    } catch (err) {
      setMessage({ text: errorText(err, "miniapp.pres.saveError"), alert: true });
    }
    setBusy(false);
  };
  return (
    <div data-testid="manual-status">
      <p>
        {current === "unknown"
          ? t("miniapp.pres.manual.none")
          : t(`miniapp.pres.manual.${current}`, { time: localTime(until!, timeZone) })}
      </p>
      {r.status === "active" && (
        <div style={row}>
          <label htmlFor={ttlId}>
            {t("miniapp.pres.ttl")}
            <select id={ttlId} value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
              {TTL_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {t("miniapp.pres.ttlMinutes", { n: m })}
                </option>
              ))}
            </select>
          </label>
          <Button disabled={busy} onClick={() => void put("available_now")}>
            {t("miniapp.pres.setAvailable")}
          </Button>
          <Button disabled={busy} onClick={() => void put("busy")}>
            {t("miniapp.pres.setBusy")}
          </Button>
          {current !== "unknown" && (
            <Button disabled={busy} onClick={() => void put("unknown")}>
              {t("miniapp.pres.clear")}
            </Button>
          )}
        </div>
      )}
      <Live message={message} testId="manual-status-message" />
    </div>
  );
}
