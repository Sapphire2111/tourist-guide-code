// P07 акции заведения (Offer): список, создание, правка, архив (вместо удаления). Отзывы — блок 10, здесь нет.
import { useId, useState } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Link, Stack, useT } from "@tg/ui";
import { AsyncView, Badge, card, listStyle } from "../guide/parts.js";
import { useErrorText } from "../host/errors.js";
import { orgOfPlace, useKeptAsync, usePartnerOrgs, usePartner } from "./context.js";
import type { Offer, OfferInput } from "./partner-api.js";
import { Live, type Message } from "./parts.js";

type Draft = { title: string; description: string; startsAt: string; endsAt: string };
const EMPTY: Draft = { title: "", description: "", startsAt: "", endsAt: "" };

/** Часовой пояс дат акций: регион (Косівщина) — «до 10.11 включно» означает конец 10.11 по Києву. */
export const OFFER_TZ = "Europe/Kyiv";

/** Смещение пояса tz относительно UTC в момент instant, мс. */
function tzOffset(instant: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(
    +parts.year!,
    +parts.month! - 1,
    +parts.day!,
    +parts.hour!,
    +parts.minute!,
    +parts.second!,
  );
  return local - Math.floor(instant / 1000) * 1000;
}

/** Начало дня YYYY-MM-DD в поясе tz (UTC, мс); offsetDays — сдвиг на дни. */
function dayStart(date: string, tz: string, offsetDays = 0): number {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y!, m! - 1, d! + offsetDays);
  const first = guess - tzOffset(guess, tz);
  return guess - tzOffset(first, tz);
}

/** ISO → день в поясе tz для <input type="date"> (YYYY-MM-DD). */
export function dayOf(iso: string | null, tz = OFFER_TZ): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/**
 * Форма → тело запроса: начало дня начала и конец дня окончания (23:59:59) по поясу региона. null — конец не
 * позже начала.
 */
export function offerInput(d: Draft, tz = OFFER_TZ): OfferInput | null {
  const startsAt = d.startsAt ? new Date(dayStart(d.startsAt, tz)).toISOString() : null;
  const endsAt = d.endsAt ? new Date(dayStart(d.endsAt, tz, 1) - 1000).toISOString() : null;
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) return null;
  return {
    title: { uk: d.title.trim() },
    description: d.description.trim() ? { uk: d.description.trim() } : null,
    startsAt,
    endsAt,
  };
}

function OfferForm({
  placeId,
  editing,
  onDone,
}: {
  placeId: string;
  editing: Offer | null;
  onDone: (text: string) => void;
}) {
  const { t } = useT();
  const { api } = usePartner();
  const errorText = useErrorText();
  const [d, setD] = useState<Draft>(() =>
    editing
      ? {
          title: editing.title.uk,
          description: editing.description?.uk ?? "",
          startsAt: dayOf(editing.startsAt),
          endsAt: dayOf(editing.endsAt),
        }
      : EMPTY,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const ids = { title: useId(), desc: useId(), starts: useId(), ends: useId() };
  const set = (k: keyof Draft) => (e: { target: { value: string } }) =>
    setD((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    if (!d.title.trim()) {
      setMessage({ text: t("miniapp.partner.offers.needTitle"), alert: true });
      return;
    }
    const input = offerInput(d);
    if (!input) {
      setMessage({ text: t("errors.partner.offerPeriod"), alert: true });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      if (editing) await api.updateOffer(placeId, editing.id, input);
      else await api.createOffer(placeId, input);
      setD(EMPTY);
      onDone(t(editing ? "miniapp.partner.offers.saved" : "miniapp.partner.offers.created"));
    } catch (err) {
      setMessage({ text: errorText(err, "miniapp.partner.offers.error"), alert: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section style={card} aria-labelledby="offer-form-title">
      <h2 id="offer-form-title">
        {t(editing ? "miniapp.partner.offers.edit" : "miniapp.partner.offers.new")}
      </h2>
      <Stack>
        <label htmlFor={ids.title}>
          {t("miniapp.partner.offers.titleField")}
          <input id={ids.title} value={d.title} maxLength={200} onChange={set("title")} />
        </label>
        <label htmlFor={ids.desc}>
          {t("miniapp.partner.offers.description")}
          <textarea
            id={ids.desc}
            rows={3}
            maxLength={4000}
            value={d.description}
            onChange={set("description")}
          />
        </label>
        <label htmlFor={ids.starts}>
          {t("miniapp.partner.offers.starts")}
          <input id={ids.starts} type="date" value={d.startsAt} onChange={set("startsAt")} />
        </label>
        <label htmlFor={ids.ends}>
          {t("miniapp.partner.offers.ends")}
          <input id={ids.ends} type="date" value={d.endsAt} onChange={set("endsAt")} />
        </label>
        <Live message={message} testId="offer-form-message" />
        <Button onClick={() => void save()} disabled={busy}>
          {t(editing ? "miniapp.partner.offers.save" : "miniapp.partner.offers.create")}
        </Button>
        {editing && <Button onClick={() => onDone("")}>{t("miniapp.partner.offers.cancel")}</Button>}
      </Stack>
    </section>
  );
}

export function PartnerOffers({ placeId }: { placeId: string }) {
  const { t, locale } = useT();
  const { api, enabled } = usePartner();
  const orgs = usePartnerOrgs();
  const errorText = useErrorText();
  const org = orgOfPlace(orgs, placeId);
  const [list, reload, refreshError] = useKeptAsync(
    () => (enabled ? api.offers(placeId) : Promise.resolve([])),
    [api, placeId, enabled],
  );
  const [editing, setEditing] = useState<Offer | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!enabled) return <p role="alert">{t("miniapp.partner.needsLogin")}</p>;
  const forbidden = org !== null && !org.abilities.manageOffers;
  const archive = async (o: Offer) => {
    setMessage(null);
    setBusy(true);
    try {
      await api.archiveOffer(placeId, o.id);
      setMessage({ text: t("miniapp.partner.offers.archived"), alert: false });
    } catch (err) {
      setMessage({ text: errorText(err, "miniapp.partner.offers.error"), alert: true });
    }
    setBusy(false);
    setConfirm(null);
    reload();
  };
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale, { timeZone: OFFER_TZ });
  return (
    <Stack>
      <h1>{t("miniapp.partner.offers.title")}</h1>
      <Link to="/partner">{t("miniapp.partner.toDashboard")}</Link>
      {forbidden ? (
        <p role="alert">{t("miniapp.partner.offers.forbidden")}</p>
      ) : (
        <>
          <Live message={message} testId="offers-message" />
          {refreshError !== null && <p role="alert">{t("miniapp.partner.refreshError")}</p>}
          <AsyncView
            state={list}
            retry={reload}
            errorText={errorText(list.status === "error" ? list.error : null, "miniapp.partner.loadError")}
          >
            {(items) =>
              items.length ? (
                <ul style={listStyle} data-testid="offers">
                  {items.map((o) => {
                    const title = pickLocalized(o.title, locale);
                    return (
                      <li key={o.id} style={card} data-testid="offer-item">
                        <strong style={{ display: "block" }}>{title}</strong>
                        <Badge testId="offer-status">
                          {t(`miniapp.partner.offers.status.${o.status}` as MessageKey)}
                        </Badge>
                        {o.description && (
                          <p style={{ whiteSpace: "pre-line" }}>{pickLocalized(o.description, locale)}</p>
                        )}
                        {(o.startsAt || o.endsAt) && (
                          <small style={{ display: "block" }}>
                            {[
                              o.startsAt && t("miniapp.partner.offers.from", { date: date(o.startsAt) }),
                              o.endsAt && t("miniapp.partner.offers.to", { date: date(o.endsAt) }),
                            ]
                              .filter(Boolean)
                              .join(" ")}
                          </small>
                        )}
                        {o.status === "active" && (
                          <span style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                            <Button disabled={busy} onClick={() => setEditing(o)}>
                              {t("miniapp.partner.offers.editAction", { title })}
                            </Button>
                            {confirm === o.id ? (
                              <Button disabled={busy} onClick={() => void archive(o)}>
                                {t("miniapp.partner.offers.archiveConfirm")}
                              </Button>
                            ) : (
                              <Button disabled={busy} onClick={() => setConfirm(o.id)}>
                                {t("miniapp.partner.offers.archive", { title })}
                              </Button>
                            )}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p>{t("miniapp.partner.offers.empty")}</p>
              )
            }
          </AsyncView>
          <OfferForm
            key={editing?.id ?? "new"}
            placeId={placeId}
            editing={editing}
            onDone={(text) => {
              setEditing(null);
              if (text) setMessage({ text, alert: false });
              reload();
            }}
          />
        </>
      )}
    </Stack>
  );
}
