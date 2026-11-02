// C03 «Про заклад» + форма заявки (S-03): правила, Wi-Fi, контакты, часы приёма, услуги → заявка.
// Номер комнаты — из QR номера, иначе вводит гость (помечается «вказано гостем», D-49).
// Вне часов приёма заявка принимается с пометкой «буде оброблено з …» (D-55, вариант Б).
import { useId, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { pickLocalized } from "@tg/i18n";
import { Button, Link, Stack, useFeatureFlag, useT } from "@tg/ui";
import { uuidv7 } from "../guide/analytics.js";
import { useAsync, useGuide } from "../guide/context.js";
import { AsyncView, card, listStyle } from "../guide/parts.js";
import { NotFoundError, UnauthorizedError } from "../guide/types.js";
import { useHost } from "./context.js";
import { isMessageKey, useErrorText } from "./errors.js";
import { formatTime } from "./format.js";
import {
  ApiCallError,
  isAmbiguous,
  type HostModule,
  type HostService,
  type ServiceRequest,
} from "./types.js";

/** Длины полей — как в CreateServiceRequestDto сервера. */
export const ROOM_LABEL_MAX = 20;
export const COMMENT_MAX = 500;

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

/** header — карточка заведения из контекста QR (ContextView, h1 — название); ниже — HostModule. */
export function About({ header }: { header: ReactNode }) {
  const { t } = useT();
  const { api, hotelPlaceId, entryContextId } = useHost();
  const requests = useFeatureFlag("module.host_requests");
  const [mod, retry] = useAsync(
    () => (hotelPlaceId ? api.hostModule(hotelPlaceId, entryContextId) : Promise.reject(new NotFoundError())),
    [api, hotelPlaceId, entryContextId],
  );
  return (
    <Stack>
      {header}
      {mod.status === "error" && mod.error instanceof NotFoundError ? (
        // Модуль не включён/не настроен: информация с QR видна, заявок нет.
        <p data-testid="about-empty">{t("miniapp.about.empty")}</p>
      ) : (
        <AsyncView state={mod} retry={retry}>
          {(m) => <AboutView module={m} />}
        </AsyncView>
      )}
      {requests && (
        <Link to="/requests" data-testid="my-requests-link" style={{ fontSize: "1.2rem", fontWeight: 700 }}>
          {t("miniapp.about.myRequests")}
        </Link>
      )}
    </Stack>
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
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const copy = async () => {
    try {
      // В части WebView Telegram clipboard недоступен — тогда просим скопировать вручную.
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(wifi.password ?? "");
      setCopied("ok");
    } catch {
      setCopied("failed");
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
          <span role="status" data-testid="copy-status">
            {copied === "ok" ? ` ${t("miniapp.about.copied")}` : ""}
            {copied === "failed" ? ` ${t("miniapp.about.copyFailed")}` : ""}
          </span>
        </>
      )}
    </section>
  );
}

function AboutView({ module: m }: { module: HostModule }) {
  const { t, locale } = useT();
  const { timeZone } = useHost();
  const requests = useFeatureFlag("module.host_requests");
  const [service, setService] = useState<HostService | null>(null);
  const [sent, setSent] = useState<ServiceRequest | null>(null);
  const empty = m.sections.length === 0 && !m.wifi && !m.phone && m.services.length === 0;
  return (
    <Stack>
      {empty && <p data-testid="about-empty">{t("miniapp.about.empty")}</p>}
      {m.room && <p data-testid="about-room">{t("miniapp.request.roomFromQr", { room: m.room.value })}</p>}
      {m.sections.map((sec, i) => (
        <section key={i} style={card} aria-labelledby={`host-section-${i}`} data-testid="host-section">
          <h2 id={`host-section-${i}`} style={{ fontSize: "1.1rem", margin: "0 0 6px" }}>
            {pickLocalized(sec.title, locale)}
          </h2>
          <p style={{ whiteSpace: "pre-line", margin: 0 }}>{pickLocalized(sec.content, locale)}</p>
        </section>
      ))}
      {m.wifi && <Wifi wifi={m.wifi} />}
      {m.phone && (
        <section style={card} aria-labelledby="contacts-title">
          <h2 id="contacts-title" style={{ fontSize: "1.1rem", margin: "0 0 6px" }}>
            {t("miniapp.about.contacts")}
          </h2>
          <a href={`tel:${m.phone}`} style={{ fontSize: "1.2rem", fontWeight: 700 }}>
            {t("miniapp.about.call")} {m.phone}
          </a>
        </section>
      )}
      {sent && (
        <p role="status" data-testid="request-sent">
          {sent.processFrom
            ? t("miniapp.request.sentDeferred", { from: formatTime(sent.processFrom, locale, timeZone) })
            : t("miniapp.request.sent")}
        </p>
      )}
      {requests && m.services.length > 0 && (
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
    </Stack>
  );
}

/**
 * Форма заявки. Idempotency-Key: один на «тело» заявки — правка полей даёт новый ключ. После неоднозначной ошибки
 * (сеть, 5xx, 429) исход неизвестен: поля блокируются, «Повторити» шлёт тот же ключ (сервер не создаст дубль);
 * «Змінити заявку» снимает блокировку, и следующая отправка пойдёт с новым ключом.
 */
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
  const errorText = useErrorText();
  const { api, entryContextId } = useHost();
  const qrRoom = m.room?.source === "qr" ? m.room.value : null;
  const { signedIn } = useGuide();
  const [room, setRoom] = useState("");
  const [comment, setComment] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => uuidv7());
  /** Отправка с этим ключом могла дойти — поля заморожены до повтора или явной правки. */
  const [locked, setLocked] = useState(false);
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
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    setIdempotencyKey(uuidv7());
  };
  const unlock = () => {
    setLocked(false);
    setError(null);
    setIdempotencyKey(uuidv7());
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const roomLabel = room.trim();
    if (!qrRoom && !roomLabel) {
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
        roomLabel: qrRoom ? null : roomLabel,
        entryContextId,
        idempotencyKey,
      });
      onSent(created);
      return;
    } catch (err) {
      const code = err instanceof ApiCallError ? err.code : null;
      if (code === "IDEMPOTENCY_IN_PROGRESS") {
        setLocked(true);
        setError(t("miniapp.request.processing"));
      } else if (code === "IDEMPOTENCY_KEY_REUSED") {
        setLocked(false);
        setIdempotencyKey(uuidv7());
        setError(t("miniapp.request.keyReused"));
      } else if (isAmbiguous(err)) {
        setLocked(true);
        setError(t("miniapp.request.uncertain"));
      } else {
        setLocked(false);
        // Окончательный 4xx: сервер сохранил ответ под ключом — повтор с тем же ключом вернул бы его же. Прочие
        // ошибки (например, неожиданная форма ответа 2xx) — исход неизвестен, ключ прежний, повтор идемпотентен.
        const final =
          (err instanceof ApiCallError && err.status >= 400 && err.status < 500) ||
          err instanceof NotFoundError ||
          err instanceof UnauthorizedError;
        if (final) setIdempotencyKey(uuidv7());
        const known = err instanceof ApiCallError && isMessageKey(err.messageKey);
        setError(
          !known && err instanceof ApiCallError && err.status === 409
            ? t("miniapp.request.duplicate")
            : errorText(err, "miniapp.request.error"),
        );
      }
    }
    setBusy(false);
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
            onChange={(e) => edit(setRoom)(e.target.value)}
            readOnly={locked}
            maxLength={ROOM_LABEL_MAX}
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
          onChange={(e) => edit(setComment)(e.target.value)}
          readOnly={locked}
          maxLength={COMMENT_MAX}
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
          {busy
            ? t("miniapp.request.sending")
            : locked
              ? t("miniapp.request.retry")
              : t("miniapp.request.submit")}
        </Button>
        {locked && (
          <Button onClick={unlock} disabled={busy}>
            {t("miniapp.request.edit")}
          </Button>
        )}
        <Button onClick={onCancel} disabled={busy}>
          {t("miniapp.request.cancel")}
        </Button>
      </div>
    </form>
  );
}
