// C03 «Про заклад» + форма заявки (S-03): правила, Wi-Fi, контакты, часы приёма, услуги → заявка.
// Номер комнаты — из QR номера, иначе вводит гость (помечается «вказано гостем», D-49).
// Вне часов приёма заявка принимается с пометкой «буде оброблено з …» (D-55, вариант Б).
import { useId, useState, type CSSProperties, type FormEvent } from "react";
import { pickLocalized } from "@tg/i18n";
import { Button, Link, Stack, useT } from "@tg/ui";
import { useAsync, useGuide } from "../guide/context.js";
import { AsyncView, card, listStyle } from "../guide/parts.js";
import { NotFoundError } from "../guide/types.js";
import { roomOf, useHost } from "./context.js";
import { ConflictError, type HostModule, type HostService, type ServiceRequest } from "./types.js";

const field: CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  padding: 8,
  marginTop: 4,
  fontSize: "1rem",
  color: "var(--color-text)",
  background: "var(--color-bg)",
  border: "1px solid var(--color-hint)",
  borderRadius: "var(--radius)",
};

export function About() {
  const { t } = useT();
  const { api, hotelPlaceId } = useHost();
  const [mod, retry] = useAsync(
    () => (hotelPlaceId ? api.hostModule(hotelPlaceId) : Promise.reject(new NotFoundError())),
    [api, hotelPlaceId],
  );
  if (mod.status === "error" && mod.error instanceof NotFoundError)
    return (
      <Stack>
        <h1>{t("miniapp.about.title")}</h1>
        <p role="alert" data-testid="about-unavailable">
          {t("miniapp.about.unavailable")}
        </p>
      </Stack>
    );
  return (
    <AsyncView state={mod} retry={retry}>
      {(m) => <AboutView module={m} />}
    </AsyncView>
  );
}

function Intake({ module: m }: { module: HostModule }) {
  const { t } = useT();
  if (!m.intake) return <p>{t("miniapp.about.intakeAllDay")}</p>;
  return (
    <>
      <p data-testid="intake-hours">{t("miniapp.about.intake", m.intake)}</p>
      {!m.acceptingNow && (
        <p role="note" data-testid="intake-closed">
          {t("miniapp.about.intakeClosed", { from: m.intake.from })}
        </p>
      )}
    </>
  );
}

function Wifi({ wifi }: { wifi: NonNullable<HostModule["wifi"]> }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wifi.password ?? "");
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section style={card} aria-labelledby="wifi-title">
      <h2 id="wifi-title" style={{ fontSize: "1.1rem", margin: "0 0 6px" }}>
        {t("miniapp.about.wifi")}
      </h2>
      <p>{t("miniapp.about.wifiNetwork", { ssid: wifi.ssid })}</p>
      {wifi.password && (
        <>
          <p>{t("miniapp.about.wifiPassword", { password: wifi.password })}</p>
          <Button onClick={() => void copy()}>{t("miniapp.about.copyPassword")}</Button>
          <span role="status">{copied ? ` ${t("miniapp.about.copied")}` : ""}</span>
        </>
      )}
    </section>
  );
}

function AboutView({ module: m }: { module: HostModule }) {
  const { t, locale } = useT();
  const [service, setService] = useState<HostService | null>(null);
  const [sent, setSent] = useState<ServiceRequest | null>(null);
  const empty = !m.rules && !m.wifi && !m.phone && m.services.length === 0;
  return (
    <Stack>
      <h1>{pickLocalized(m.name, locale)}</h1>
      {empty && <p data-testid="about-empty">{t("miniapp.about.empty")}</p>}
      {m.rules && (
        <section style={card} aria-labelledby="rules-title">
          <h2 id="rules-title" style={{ fontSize: "1.1rem", margin: "0 0 6px" }}>
            {t("miniapp.about.rules")}
          </h2>
          <p style={{ whiteSpace: "pre-line", margin: 0 }}>{pickLocalized(m.rules, locale)}</p>
        </section>
      )}
      {m.wifi && <Wifi wifi={m.wifi} />}
      {(m.phone || m.telegram) && (
        <section style={card} aria-labelledby="contacts-title">
          <h2 id="contacts-title" style={{ fontSize: "1.1rem", margin: "0 0 6px" }}>
            {t("miniapp.about.contacts")}
          </h2>
          {m.phone && (
            <a href={`tel:${m.phone}`}>
              {t("miniapp.about.call")} {m.phone}
            </a>
          )}
          {m.telegram && (
            <p>
              <a href={`https://t.me/${m.telegram}`} target="_blank" rel="noreferrer">
                @{m.telegram}
              </a>
            </p>
          )}
        </section>
      )}
      {sent && (
        <p role="status" data-testid="request-sent">
          {sent.deferredUntil
            ? t("miniapp.request.sentDeferred", { from: sent.deferredUntil })
            : t("miniapp.request.sent")}
        </p>
      )}
      {m.services.length > 0 && (
        <section aria-labelledby="services-title">
          <h2 id="services-title" style={{ fontSize: "1.1rem" }}>
            {t("miniapp.about.services")}
          </h2>
          <Intake module={m} />
          {service ? (
            <RequestForm
              module={m}
              service={service}
              onCancel={() => setService(null)}
              onSent={(r) => {
                setService(null);
                setSent(r);
              }}
            />
          ) : (
            <ul style={listStyle} data-testid="services">
              {m.services.map((s) => (
                <li key={s.id} style={card}>
                  <strong style={{ display: "block" }}>{pickLocalized(s.title, locale)}</strong>
                  {s.description && <p style={{ margin: "4px 0" }}>{pickLocalized(s.description, locale)}</p>}
                  {s.slaMinutes && (
                    <p style={{ margin: "4px 0" }}>{t("miniapp.about.sla", { n: s.slaMinutes })}</p>
                  )}
                  <Button
                    onClick={() => {
                      setSent(null);
                      setService(s);
                    }}
                    aria-label={`${t("miniapp.about.order")}: ${pickLocalized(s.title, locale)}`}
                  >
                    {t("miniapp.about.order")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <Link to="/requests" data-testid="my-requests-link">
        {t("miniapp.about.myRequests")}
      </Link>
    </Stack>
  );
}

function RequestForm({
  module: m,
  service,
  onCancel,
  onSent,
}: {
  module: HostModule;
  service: HostService;
  onCancel: () => void;
  onSent: (r: ServiceRequest) => void;
}) {
  const { t, locale } = useT();
  const { api, qrRoom, entryContextId } = useHost();
  const { signedIn } = useGuide();
  const [room, setRoom] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roomId = useId();
  const commentId = useId();
  const hintId = useId();
  const title = t("miniapp.request.title", { service: pickLocalized(service.title, locale) });
  if (!signedIn)
    return (
      <div style={card}>
        <h3>{title}</h3>
        <p role="alert" data-testid="request-login">
          {t("miniapp.request.needsLogin")}
        </p>
        <Button onClick={onCancel}>{t("miniapp.request.cancel")}</Button>
      </div>
    );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const roomCtx = roomOf(qrRoom, room);
    if (!roomCtx) {
      setError(t("miniapp.request.roomRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.createRequest({
        placeId: m.placeId,
        serviceId: service.id,
        comment: comment.trim() || null,
        room: roomCtx,
        entryContextId,
      });
      onSent(created);
    } catch (err) {
      setError(t(err instanceof ConflictError ? "miniapp.request.duplicate" : "miniapp.request.error"));
      setBusy(false);
    }
  };
  return (
    <form style={card} onSubmit={(e) => void submit(e)} data-testid="request-form" aria-label={title}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {qrRoom ? (
        <p data-testid="room-from-qr">{t("miniapp.request.roomFromQr", { room: qrRoom })}</p>
      ) : (
        <p>
          <label htmlFor={roomId}>{t("miniapp.request.room")}</label>
          <input
            id={roomId}
            style={field}
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            maxLength={16}
            aria-required="true"
            aria-describedby={hintId}
            autoComplete="off"
          />
          <small id={hintId}>{t("miniapp.request.roomHint")}</small>
        </p>
      )}
      <p>
        <label htmlFor={commentId}>{t("miniapp.request.comment")}</label>
        <textarea
          id={commentId}
          style={field}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={500}
          rows={3}
        />
      </p>
      {error && (
        <p role="alert" data-testid="request-error">
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button type="submit" disabled={busy}>
          {busy ? t("miniapp.request.sending") : t("miniapp.request.submit")}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          {t("miniapp.request.cancel")}
        </Button>
      </div>
    </form>
  );
}
