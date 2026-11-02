// C22 «Мої заявки» (гость, отмена new|accepted) и режим персонала P10 (ORG_STAFF, D-50): заявки отеля,
// фильтр по статусу, переходы из allowedTransitions сервера (rejected — с причиной); 409 — список обновляется.
import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Stack, useT } from "@tg/ui";
import { useAsync, useGuide } from "../guide/context.js";
import { AsyncView, Badge, card, listStyle } from "../guide/parts.js";
import { UnauthorizedError } from "../guide/types.js";
import { useHost } from "./context.js";
import { formatDateTime } from "./format.js";
import {
  ConflictError,
  REQUEST_STATUSES,
  type RequestStatus,
  type ServiceRequest,
  type StaffTransition,
} from "./types.js";

const statusKey = (s: RequestStatus) => `miniapp.requestStatus.${s}` as MessageKey;

const input: CSSProperties = {
  padding: 8,
  fontSize: "1rem",
  color: "var(--color-text)",
  background: "var(--color-bg)",
  border: "1px solid var(--color-hint)",
  borderRadius: "var(--radius)",
};

type Message = { text: string; alert: boolean } | null;

function RequestInfo({ r }: { r: ServiceRequest }) {
  const { t, locale } = useT();
  return (
    <>
      <strong style={{ display: "block", fontSize: "1.1rem" }}>{pickLocalized(r.service, locale)}</strong>
      {r.placeName && <span style={{ display: "block" }}>{pickLocalized(r.placeName, locale)}</span>}
      <span style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "4px 0" }}>
        <Badge testId="request-status">{t(statusKey(r.status))}</Badge>
        {r.overdue && <Badge testId="request-overdue">{t("miniapp.requests.overdue")}</Badge>}
      </span>
      {r.room && (
        <span style={{ display: "block" }} data-testid="request-room">
          {t(r.room.source === "guest" ? "miniapp.requests.roomGuest" : "miniapp.requests.roomQr", {
            room: r.room.value,
          })}
        </span>
      )}
      {r.guestName && (
        <span style={{ display: "block" }}>{t("miniapp.staff.guest", { name: r.guestName })}</span>
      )}
      {r.comment && <span style={{ display: "block", whiteSpace: "pre-line" }}>{r.comment}</span>}
      {r.statusReason && (
        <span style={{ display: "block" }}>{t("miniapp.requests.reason", { reason: r.statusReason })}</span>
      )}
      {r.processFrom && r.status === "new" && (
        <span style={{ display: "block" }} data-testid="request-deferred">
          {t("miniapp.requests.deferred", { from: formatDateTime(r.processFrom, locale) })}
        </span>
      )}
      <small style={{ display: "block" }}>
        {t("miniapp.requests.created", { date: formatDateTime(r.createdAt, locale) })}
      </small>
    </>
  );
}

function AuthAware({ error, children }: { error: unknown; children: ReactNode }) {
  const { t } = useT();
  if (error instanceof UnauthorizedError)
    return (
      <p role="alert" data-testid="requests-auth">
        {t("miniapp.auth.again")}
      </p>
    );
  return <>{children}</>;
}

function Live({ message, testId }: { message: Message; testId: string }) {
  return (
    <p role={message?.alert ? "alert" : "status"} data-testid={testId}>
      {message?.text ?? ""}
    </p>
  );
}

export function MyRequests() {
  const { t } = useT();
  const { signedIn } = useGuide();
  const { api } = useHost();
  const [list, retry] = useAsync(() => (signedIn ? api.myRequests() : Promise.resolve([])), [api, signedIn]);
  const [message, setMessage] = useState<Message>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const cancel = async (r: ServiceRequest) => {
    setBusyId(r.id);
    setMessage(null);
    try {
      await api.cancelRequest(r.id);
      setMessage({ text: t("miniapp.requests.cancelled"), alert: false });
    } catch (err) {
      setMessage({
        text: t(err instanceof ConflictError ? "miniapp.staff.conflict" : "miniapp.requests.cancelError"),
        alert: true,
      });
    } finally {
      setBusyId(null);
      retry();
    }
  };
  return (
    <Stack>
      <h1>{t("miniapp.requests.title")}</h1>
      {!signedIn ? (
        <p data-testid="requests-login">{t("miniapp.request.needsLogin")}</p>
      ) : (
        <>
          <Live message={message} testId="requests-message" />
          <AuthAware error={list.status === "error" ? list.error : null}>
            <AsyncView state={list} retry={retry}>
              {(items) =>
                items.length ? (
                  <ul style={listStyle} data-testid="my-requests">
                    {items.map((r) => (
                      <li key={r.id} style={card} data-testid="request-item">
                        <RequestInfo r={r} />
                        {r.cancellable && (
                          <Button
                            style={{ marginTop: 8 }}
                            disabled={busyId === r.id}
                            onClick={() => void cancel(r)}
                          >
                            {t("miniapp.requests.cancel")}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p data-testid="requests-empty">{t("miniapp.requests.empty")}</p>
                )
              }
            </AsyncView>
          </AuthAware>
        </>
      )}
    </Stack>
  );
}

function StaffActions({
  r,
  busy,
  onChange,
}: {
  r: ServiceRequest;
  busy: boolean;
  onChange: (to: StaffTransition, reason: string | null) => void;
}) {
  const { t } = useT();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  if (rejecting)
    return (
      <form
        style={{ marginTop: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim()) onChange("rejected", reason.trim());
        }}
      >
        <label htmlFor={reasonId} style={{ display: "block" }}>
          {t("miniapp.staff.reason")}
        </label>
        <input
          id={reasonId}
          style={{ ...input, width: "100%", boxSizing: "border-box" }}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={200}
          aria-required="true"
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <Button type="submit" disabled={busy || !reason.trim()}>
            {t("miniapp.staff.to.rejected")}
          </Button>
          <Button onClick={() => setRejecting(false)}>{t("miniapp.request.cancel")}</Button>
        </div>
      </form>
    );
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
      {r.transitions.map((to) => (
        <Button
          key={to}
          disabled={busy}
          onClick={() => (to === "rejected" ? setRejecting(true) : onChange(to, null))}
        >
          {t(`miniapp.staff.to.${to}` as MessageKey)}
        </Button>
      ))}
    </div>
  );
}

export function StaffRequests() {
  const { t } = useT();
  const { api, staff } = useHost();
  const [filter, setFilter] = useState<RequestStatus | "">("");
  const [list, retry] = useAsync(
    () => (staff ? api.staffRequests(filter || null) : Promise.resolve([])),
    [api, staff, filter],
  );
  const [message, setMessage] = useState<Message>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  if (!staff)
    return (
      <Stack>
        <h1>{t("miniapp.staff.title")}</h1>
        <p role="alert" data-testid="staff-forbidden">
          {t("miniapp.staff.forbidden")}
        </p>
      </Stack>
    );
  const change = async (r: ServiceRequest, to: StaffTransition, reason: string | null) => {
    setBusyId(r.id);
    setMessage(null);
    try {
      await api.setStatus(r.id, to, reason);
      setMessage({ text: t("miniapp.staff.changed", { status: t(statusKey(to)) }), alert: false });
    } catch (err) {
      setMessage({
        text: t(err instanceof ConflictError ? "miniapp.staff.conflict" : "miniapp.staff.error"),
        alert: true,
      });
    } finally {
      setBusyId(null);
      retry();
    }
  };
  return (
    <Stack>
      <h1>{t("miniapp.staff.title")}</h1>
      <label>
        {t("miniapp.staff.filter")}{" "}
        <select
          style={input}
          value={filter}
          onChange={(e) => setFilter(e.target.value as RequestStatus | "")}
          data-testid="staff-filter"
        >
          <option value="">{t("miniapp.staff.all")}</option>
          {REQUEST_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(statusKey(s))}
            </option>
          ))}
        </select>
      </label>
      <Live message={message} testId="staff-message" />
      <AuthAware error={list.status === "error" ? list.error : null}>
        <AsyncView state={list} retry={retry}>
          {(items) =>
            items.length ? (
              <ul style={listStyle} data-testid="staff-requests">
                {items.map((r) => (
                  <li key={r.id} style={card} data-testid="staff-request">
                    <RequestInfo r={r} />
                    <StaffActions
                      r={r}
                      busy={busyId === r.id}
                      onChange={(to, reason) => void change(r, to, reason)}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p data-testid="staff-empty">{t("miniapp.staff.empty")}</p>
            )
          }
        </AsyncView>
      </AuthAware>
    </Stack>
  );
}
