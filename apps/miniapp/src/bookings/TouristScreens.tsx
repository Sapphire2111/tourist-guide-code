// Бронирование туриста (блок 7, флаг module.bookings): C07 «Доступно зараз» — ресурс, дата, слот; C08 «Бронювання»
// — кількість осіб, телефон (Telegram requestContact или вручную, D-42), коментар и обязательная галочка согласия на
// передачу телефона этому заведению (ТЗ §14.1) до отправки; C21 «Мої бронювання» — статусы, отмена, ответ на
// альтернативу. Экран грузится лениво (не входит в первый экран).
import { useEffect, useId, useState } from "react";
import { pickLocalized } from "@tg/i18n";
import { Button, Link, Stack, useT } from "@tg/ui";
import { useAsync, useGuide } from "../guide/context.js";
import { AsyncView, card, listStyle } from "../guide/parts.js";
import { NotFoundError, UnauthorizedError, type PlaceDetail } from "../guide/types.js";
import { ApiCallError } from "../host/types.js";
import { Live, type Message } from "../partner/parts.js";
import type { TelegramWebApp } from "../telegram.js";
import type { Booking, Resource, Slot, StatusChange } from "./bookings-api.js";
import { useBookings } from "./context.js";
import { addDays, dayLabel, localDate, localTime, normalizePhone, whenLabel } from "./format.js";
import { Reason, StatusBadge, useBookingErrorText, useIdempotencyKey } from "./parts.js";

/** Bot API 6.9+: запрос номера пользователя; номер — в responseUnsafe.contact (новые клиенты). */
type ContactResponse = { status?: string; responseUnsafe?: { contact?: { phone_number?: string } } };
type ContactWebApp = TelegramWebApp & {
  requestContact?(cb?: (sent: boolean, res?: ContactResponse) => void): void;
};

/** До начала confirmed-брони — не позже стольких часов (BOOKING_PARAMS.userCancelBeforeStartHours сервера). */
export const CANCEL_BEFORE_HOURS = 2;

const ACTIVE = new Set(["new", "pending_partner", "alternative_proposed", "confirmed"]);

// --- C07 / C08 ---

export function BookingFlow({ placeId }: { placeId: string }) {
  const { t } = useT();
  const guide = useGuide();
  const { api } = useBookings();
  const regionId = guide.regionId!;
  const [state, retry] = useAsync(async () => {
    const [place, resources] = await Promise.all([
      guide.api.place(placeId),
      api.resources(regionId, placeId),
    ]);
    return { place, resources };
  }, [guide.api, api, regionId, placeId]);
  if (state.status === "error" && state.error instanceof NotFoundError)
    return <p role="alert">{t("miniapp.place.notFound")}</p>;
  return (
    <AsyncView state={state} retry={retry} errorText={t("miniapp.booking.loadError")}>
      {({ place, resources }) => <Flow place={place} resources={resources} />}
    </AsyncView>
  );
}

function CallPlace({ place }: { place: PlaceDetail }) {
  const { t } = useT();
  if (!place.phone) return null;
  return (
    <a href={`tel:${place.phone}`} className="kosiv-action" data-variant="ghost">
      {t("miniapp.place.call")}
    </a>
  );
}

function Flow({ place, resources }: { place: PlaceDetail; resources: Resource[] }) {
  const { t, locale } = useT();
  const { signedIn } = useGuide();
  const name = pickLocalized(place.name, locale);
  const [resourceId, setResourceId] = useState(
    () => (resources.find((r) => r.availability.availableNow) ?? resources[0])?.id ?? "",
  );
  const [slot, setSlot] = useState<Slot | null>(null);
  const [done, setDone] = useState<Booking | null>(null);
  const [notice, setNotice] = useState<Message>(null);
  const [reload, setReload] = useState(0);
  const resource = resources.find((r) => r.id === resourceId);
  const resourceLabel = useId();

  if (!resource)
    return (
      <Stack>
        <h1>{name}</h1>
        <p data-testid="booking-unavailable">{t("miniapp.booking.unavailable")}</p>
        <CallPlace place={place} />
      </Stack>
    );
  if (done) return <Done place={place} booking={done} />;
  return (
    <Stack>
      <h1>{t(slot ? "miniapp.booking.formTitle" : "miniapp.booking.slotsTitle", { name })}</h1>
      {!signedIn && (
        <p role="alert" data-testid="booking-needs-login">
          {t("miniapp.booking.needsLogin")}
        </p>
      )}
      {resources.length > 1 && !slot && (
        <label htmlFor={resourceLabel}>
          {t("miniapp.booking.resource")}
          <select
            id={resourceLabel}
            value={resourceId}
            onChange={(e) => {
              setResourceId(e.target.value);
              setNotice(null);
            }}
          >
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {pickLocalized(r.name, locale)}
              </option>
            ))}
          </select>
        </label>
      )}
      {slot ? (
        <BookingForm
          place={place}
          resource={resource}
          slot={slot}
          canSubmit={signedIn}
          onBack={(message) => {
            setSlot(null);
            setNotice(message ?? null);
            if (message) setReload((n) => n + 1);
          }}
          onDone={setDone}
        />
      ) : (
        <SlotPicker
          key={`${resource.id}:${reload}`}
          place={place}
          resource={resource}
          notice={notice}
          onPick={(s) => {
            setNotice(null);
            setSlot(s);
          }}
        />
      )}
    </Stack>
  );
}

function SlotPicker({
  place,
  resource,
  notice,
  onPick,
}: {
  place: PlaceDetail;
  resource: Resource;
  notice: Message;
  onPick: (s: Slot) => void;
}) {
  const { t, locale } = useT();
  const { regionId } = useGuide();
  const { api, timeZone } = useBookings();
  const [state, retry] = useAsync(
    () => api.slots(regionId!, resource.id, undefined, 7),
    [api, regionId, resource.id],
  );
  const [date, setDate] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Slot | null>(null);
  const a = resource.availability;
  return (
    <>
      <p data-testid="booking-availability">
        {a.availableNow
          ? a.source === "manual" && a.manualExpiresAt
            ? t("miniapp.booking.availableManual", { time: localTime(a.manualExpiresAt, timeZone) })
            : t("miniapp.booking.availableNow")
          : t("miniapp.place.checkAvailability")}
      </p>
      {resource.description && <p className="kosiv-muted">{pickLocalized(resource.description, locale)}</p>}
      <Live message={notice} testId="slots-notice" />
      <AsyncView state={state} retry={retry} errorText={t("miniapp.booking.slotsError")}>
        {(list) => {
          const tz = list.timezone || timeZone;
          const days = Array.from({ length: list.days }, (_, i) => addDays(list.from, i));
          const byDay = (d: string) => list.items.filter((s) => localDate(s.startsAt, tz) === d);
          const anyFree = list.items.some((s) => s.free);
          const current = date ?? days.find((d) => byDay(d).some((s) => s.free)) ?? days[0]!;
          const slots = byDay(current);
          if (!anyFree)
            return (
              <div className="kosiv-card kosiv-empty" data-testid="slots-empty">
                <p>{t("miniapp.booking.noSlotsWeek")}</p>
                <CallPlace place={place} />
              </div>
            );
          return (
            <>
              <div
                role="group"
                aria-label={t("miniapp.booking.date")}
                style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
              >
                {days.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="kosiv-toggle"
                    aria-pressed={d === current}
                    onClick={() => {
                      setDate(d);
                      setChosen(null);
                    }}
                  >
                    {dayLabel(d, locale)}
                  </button>
                ))}
              </div>
              {slots.some((s) => s.free) ? (
                <ul
                  aria-label={t("miniapp.booking.slots")}
                  data-testid="slots"
                  style={{ ...listStyle, flexDirection: "row", flexWrap: "wrap", gap: 8 }}
                >
                  {slots.map((s) => {
                    const time = localTime(s.startsAt, tz);
                    return (
                      <li key={s.startsAt}>
                        <button
                          type="button"
                          className="kosiv-toggle"
                          disabled={!s.free}
                          aria-pressed={chosen?.startsAt === s.startsAt}
                          aria-label={s.free ? time : t("miniapp.booking.slotBusy", { time })}
                          style={s.free ? undefined : { opacity: 0.45, textDecoration: "line-through" }}
                          onClick={() => setChosen(s)}
                        >
                          {time}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p data-testid="slots-day-empty">{t("miniapp.booking.noSlotsDay")}</p>
              )}
              <Button disabled={!chosen} onClick={() => chosen && onPick(chosen)} data-testid="slot-pick">
                {t("miniapp.booking.pickSlot")}
              </Button>
            </>
          );
        }}
      </AsyncView>
    </>
  );
}

function BookingForm({
  place,
  resource,
  slot,
  canSubmit,
  onBack,
  onDone,
}: {
  place: PlaceDetail;
  resource: Resource;
  slot: Slot;
  canSubmit: boolean;
  /** Назад к слотам; message — почему (слот заняли), слоты перечитываются. */
  onBack: (message?: Message) => void;
  onDone: (b: Booking) => void;
}) {
  const { t, locale } = useT();
  const { regionId, webApp } = useGuide();
  const { api, timeZone } = useBookings();
  const errorText = useBookingErrorText();
  const idem = useIdempotencyKey();
  const placeName = pickLocalized(place.name, locale);
  const [people, setPeople] = useState(1);
  const [phoneRaw, setPhoneRaw] = useState("");
  const [phoneSource, setPhoneSource] = useState<"telegram_contact" | "manual">("manual");
  const [comment, setComment] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  const ids = { people: useId(), phone: useId(), comment: useId(), consent: useId() };
  const phone = normalizePhone(phoneRaw);
  const tg = webApp as ContactWebApp | undefined;
  const user = tg?.initDataUnsafe?.user;
  const contactName = user ? [user.first_name, user.last_name].filter(Boolean).join(" ") : null;
  const cap = resource.capacityPeople;

  const shareContact = () => {
    setMessage(null);
    tg?.requestContact?.((sent, res) => {
      const number = res?.responseUnsafe?.contact?.phone_number;
      const normalized = number ? normalizePhone(number.startsWith("+") ? number : `+${number}`) : null;
      if (sent && normalized) {
        setPhoneRaw(normalized);
        setPhoneSource("telegram_contact");
      } else
        setMessage({
          text: t(sent ? "miniapp.booking.contactNoData" : "miniapp.booking.contactCancelled"),
          alert: sent,
        });
    });
  };

  const submit = async () => {
    if (!phone) {
      setMessage({ text: t("miniapp.booking.phoneInvalid"), alert: true });
      return;
    }
    if (!consent) {
      setMessage({ text: t("miniapp.booking.consentRequired"), alert: true });
      return;
    }
    const body = {
      regionId: regionId!,
      resourceId: resource.id,
      startsAt: slot.startsAt,
      peopleCount: people,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
      phone,
      phoneSource,
      phoneShareConsent: true,
    };
    setBusy(true);
    setMessage(null);
    try {
      const created = await api.create(body, idem.keyFor(body));
      idem.settle();
      onDone(created);
    } catch (e) {
      idem.settle(e);
      setBusy(false);
      const key = e instanceof ApiCallError ? e.messageKey : null;
      if (key === "errors.booking.slotTaken" || key === "errors.booking.slotUnavailable") {
        onBack({ text: errorText(e, "miniapp.booking.sendError"), alert: true });
        return;
      }
      setMessage({
        text:
          e instanceof UnauthorizedError
            ? t("miniapp.auth.again")
            : errorText(e, "miniapp.booking.sendError"),
        alert: true,
      });
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Stack>
        <dl data-testid="booking-summary">
          <dt>{t("miniapp.booking.resource")}</dt>
          <dd>{pickLocalized(resource.name, locale)}</dd>
          <dt>{t("miniapp.booking.when")}</dt>
          <dd>{whenLabel(slot.startsAt, timeZone, locale)}</dd>
          {resource.priceMinor !== null && resource.currency && (
            <>
              <dt>{t("miniapp.booking.price")}</dt>
              <dd>
                {(resource.priceMinor / 100).toLocaleString("uk-UA")} {resource.currency}
              </dd>
            </>
          )}
          {contactName && (
            <>
              <dt>{t("miniapp.booking.contact")}</dt>
              <dd>{contactName}</dd>
            </>
          )}
        </dl>
        <Button type="button" onClick={() => onBack()}>
          {t("miniapp.booking.changeTime")}
        </Button>
        <div>
          <label htmlFor={ids.people}>{t("miniapp.booking.people", { max: cap })}</label>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button
              type="button"
              aria-label={t("miniapp.booking.peopleLess")}
              disabled={people <= 1}
              onClick={() => setPeople((n) => Math.max(1, n - 1))}
            >
              −
            </Button>
            <input
              id={ids.people}
              type="number"
              inputMode="numeric"
              min={1}
              max={cap}
              value={people}
              style={{ width: 80 }}
              onChange={(e) => setPeople(Math.min(cap, Math.max(1, Math.trunc(Number(e.target.value)) || 1)))}
            />
            <Button
              type="button"
              aria-label={t("miniapp.booking.peopleMore")}
              disabled={people >= cap}
              onClick={() => setPeople((n) => Math.min(cap, n + 1))}
            >
              +
            </Button>
          </span>
        </div>
        <label htmlFor={ids.phone}>
          {t("miniapp.booking.phone")}
          <input
            id={ids.phone}
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            placeholder="+380…"
            value={phoneRaw}
            aria-invalid={phoneRaw !== "" && !phone ? true : undefined}
            onChange={(e) => {
              setPhoneRaw(e.target.value);
              setPhoneSource("manual");
            }}
          />
        </label>
        {typeof tg?.requestContact === "function" && (
          <Button type="button" onClick={shareContact} data-testid="share-contact">
            {t("miniapp.booking.shareContact")}
          </Button>
        )}
        <label htmlFor={ids.comment}>
          {t("miniapp.booking.comment")}
          <textarea
            id={ids.comment}
            maxLength={500}
            rows={2}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </label>
        <label htmlFor={ids.consent}>
          <input
            id={ids.consent}
            type="checkbox"
            checked={consent}
            required
            onChange={(e) => setConsent(e.target.checked)}
            data-testid="phone-consent"
          />
          {t("miniapp.booking.consent", { place: placeName })}
        </label>
        {!online && <p role="alert">{t("miniapp.booking.offline")}</p>}
        <Live message={message} testId="booking-message" />
        <Button
          type="submit"
          disabled={busy || !consent || !phone || !online || !canSubmit}
          data-testid="booking-submit"
        >
          {t(busy ? "miniapp.booking.sending" : "miniapp.booking.submit")}
        </Button>
        {!consent && <p className="kosiv-muted">{t("miniapp.booking.consentHint")}</p>}
      </Stack>
    </form>
  );
}

function Done({ place, booking }: { place: PlaceDetail; booking: Booking }) {
  const { t, locale } = useT();
  const { timeZone } = useBookings();
  return (
    <Stack>
      <h1>{t("miniapp.booking.sent")}</h1>
      <div style={card} data-testid="booking-done">
        <p>
          <strong>{pickLocalized(place.name, locale)}</strong> · {pickLocalized(booking.resourceName, locale)}
        </p>
        <p>{whenLabel(booking.startsAt, timeZone, locale)}</p>
        <StatusBadge status={booking.status} who="user" />
        <p>
          {t(
            booking.status === "confirmed" ? "miniapp.booking.doneConfirmed" : "miniapp.booking.donePending",
          )}
        </p>
      </div>
      <Link to="/bookings" className="kosiv-cta">
        {t("miniapp.booking.mine")}
      </Link>
    </Stack>
  );
}

// --- C21 ---

/** Активные — ближайшие сверху; завершённые и отменённые — ниже, новые сверху. */
export function sortBookings(items: readonly Booking[]): Booking[] {
  const active = items
    .filter((b) => ACTIVE.has(b.status))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const past = items
    .filter((b) => !ACTIVE.has(b.status))
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  return [...active, ...past];
}

export function MyBookings() {
  const { t } = useT();
  const { regionId, signedIn } = useGuide();
  const { api } = useBookings();
  const [state, retry] = useAsync(
    () => (signedIn ? api.mine(regionId!) : Promise.reject(new UnauthorizedError())),
    [api, regionId, signedIn],
  );
  const [updated, setUpdated] = useState<Record<string, Booking>>({});
  return (
    <Stack>
      <h1>{t("miniapp.booking.mine")}</h1>
      {!signedIn ? (
        <p role="alert">{t("miniapp.booking.needsLogin")}</p>
      ) : (
        <AsyncView state={state} retry={retry} errorText={t("miniapp.booking.listError")}>
          {(items) =>
            items.length === 0 ? (
              <p className="kosiv-card kosiv-empty" data-testid="bookings-empty">
                {t("miniapp.booking.empty")}
              </p>
            ) : (
              <ul style={listStyle} data-testid="my-bookings">
                {sortBookings(items.map((b) => updated[b.id] ?? b)).map((b) => (
                  <MyBookingItem
                    key={b.id}
                    booking={b}
                    onChange={(next) => setUpdated((u) => ({ ...u, [next.id]: next }))}
                  />
                ))}
              </ul>
            )
          }
        </AsyncView>
      )}
    </Stack>
  );
}

function MyBookingItem({ booking: b, onChange }: { booking: Booking; onChange: (b: Booking) => void }) {
  const { t, locale } = useT();
  const { api, timeZone } = useBookings();
  const errorText = useBookingErrorText();
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const canCancel = b.allowedTransitions.includes("cancelled_by_user");
  const canAccept = b.status === "alternative_proposed" && b.allowedTransitions.includes("confirmed");
  // Правило «не пізніше ніж за 2 год» для подтверждённой брони; сервер проверяет сам (cancel_too_late).
  const tooLate =
    b.status === "confirmed" && Date.now() >= Date.parse(b.startsAt) - CANCEL_BEFORE_HOURS * 3_600_000;

  const change = async (c: StatusChange, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await api.setStatus(b.id, b.regionId, c);
      setConfirmCancel(false);
      onChange(next);
      setMessage({ text: done, alert: false });
    } catch (e) {
      setMessage({ text: errorText(e, "miniapp.booking.actionError"), alert: true });
    }
    setBusy(false);
  };

  return (
    <li style={card} data-testid="my-booking">
      <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{pickLocalized(b.placeName, locale)}</h2>
      <p>
        {pickLocalized(b.resourceName, locale)} · {whenLabel(b.startsAt, timeZone, locale)} ·{" "}
        {t("miniapp.booking.peopleCount", { n: b.peopleCount })}
      </p>
      <StatusBadge status={b.status} who="user" />
      <Reason reason={b.statusReason} />
      {b.status === "pending_partner" && b.partnerResponseDueAt && (
        <p className="kosiv-muted">
          {t("miniapp.booking.waitUntil", { time: whenLabel(b.partnerResponseDueAt, timeZone, locale) })}
        </p>
      )}
      {b.alternative && b.status === "alternative_proposed" && (
        <div data-testid="booking-alternative">
          <p>
            {t("miniapp.booking.alternative", { time: whenLabel(b.alternative.startsAt, timeZone, locale) })}
          </p>
          <p className="kosiv-muted">
            {t("miniapp.booking.respondBy", { time: whenLabel(b.alternative.respondBy, timeZone, locale) })}
          </p>
          <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {canAccept && (
              <Button
                disabled={busy}
                onClick={() => void change({ status: "confirmed" }, t("miniapp.booking.accepted"))}
              >
                {t("miniapp.booking.accept")}
              </Button>
            )}
            {canCancel && (
              <Button
                disabled={busy}
                onClick={() => void change({ status: "cancelled_by_user" }, t("miniapp.booking.declined"))}
              >
                {t("miniapp.booking.decline")}
              </Button>
            )}
          </span>
        </div>
      )}
      {canCancel && b.status !== "alternative_proposed" && (
        <>
          {b.status === "confirmed" && (
            <p className="kosiv-muted" data-testid="cancel-rule">
              {t(tooLate ? "miniapp.booking.cancelTooLate" : "miniapp.booking.cancelRule", {
                hours: CANCEL_BEFORE_HOURS,
              })}
            </p>
          )}
          {!tooLate &&
            (confirmCancel ? (
              <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button
                  disabled={busy}
                  onClick={() => void change({ status: "cancelled_by_user" }, t("miniapp.booking.cancelled"))}
                >
                  {t("miniapp.booking.cancelYes")}
                </Button>
                <Button disabled={busy} onClick={() => setConfirmCancel(false)}>
                  {t("miniapp.booking.cancelNo")}
                </Button>
              </span>
            ) : (
              <Button disabled={busy} onClick={() => setConfirmCancel(true)}>
                {t("miniapp.booking.cancel")}
              </Button>
            ))}
        </>
      )}
      <Live message={message} testId="my-booking-message" />
      <Link to={`/place/${b.placeId}`}>{t("miniapp.booking.openPlace")}</Link>
    </li>
  );
}
