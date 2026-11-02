// P07 акции заведения (Offer): список, создание, правка, архив (вместо удаления). Отзывы — блок 10, здесь нет.
import { useId, useState } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Link, Stack, useT } from "@tg/ui";
import { AsyncView, Badge, card, listStyle } from "../guide/parts.js";
import { useLiveAsync } from "../host/context.js";
import { useErrorText } from "../host/errors.js";
import { orgOfPlace, usePartnerOrgs, usePartner } from "./context.js";
import type { Offer, OfferInput } from "./partner-api.js";
import { Live, type Message } from "./parts.js";

type Draft = { title: string; description: string; startsAt: string; endsAt: string };
const EMPTY: Draft = { title: "", description: "", startsAt: "", endsAt: "" };

/** ISO → значение <input type="date"> (YYYY-MM-DD). */
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/** Форма → тело запроса: даты — начало дня начала и конец дня окончания (UTC). null — период неверный. */
export function offerInput(d: Draft): OfferInput | null {
  const startsAt = d.startsAt ? `${d.startsAt}T00:00:00.000Z` : null;
  const endsAt = d.endsAt ? `${d.endsAt}T23:59:59.000Z` : null;
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
          startsAt: day(editing.startsAt),
          endsAt: day(editing.endsAt),
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
  const [list, reload] = useLiveAsync(
    () => (enabled ? api.offers(placeId) : Promise.resolve([])),
    [api, placeId, enabled],
  );
  const [editing, setEditing] = useState<Offer | null>(null);
  const [message, setMessage] = useState<Message>(null);
  if (!enabled) return <p role="alert">{t("miniapp.partner.needsLogin")}</p>;
  const forbidden = org !== null && !org.abilities.manageOffers;
  const archive = async (o: Offer) => {
    setMessage(null);
    try {
      await api.archiveOffer(placeId, o.id);
      setMessage({ text: t("miniapp.partner.offers.archived"), alert: false });
    } catch (err) {
      setMessage({ text: errorText(err, "miniapp.partner.offers.error"), alert: true });
    }
    reload();
  };
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale);
  return (
    <Stack>
      <h1>{t("miniapp.partner.offers.title")}</h1>
      <Link to="/partner">{t("miniapp.partner.toDashboard")}</Link>
      {forbidden ? (
        <p role="alert">{t("miniapp.partner.offers.forbidden")}</p>
      ) : (
        <>
          <Live message={message} testId="offers-message" />
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
                            <Button onClick={() => setEditing(o)}>
                              {t("miniapp.partner.offers.editAction", { title })}
                            </Button>
                            <Button onClick={() => void archive(o)}>
                              {t("miniapp.partner.offers.archive", { title })}
                            </Button>
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
