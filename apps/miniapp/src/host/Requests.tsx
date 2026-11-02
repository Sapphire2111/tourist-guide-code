// C22 «Мої заявки» (гость) и режим персонала P10 (ORG_STAFF, D-50): список заявок отеля,
// фильтр по статусу, смена статуса new → accepted → in_progress → done | rejected; 409 — список обновляется.
import { useState, type CSSProperties } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Stack, useT } from "@tg/ui";
import { useAsync, useGuide } from "../guide/context.js";
import { AsyncView, Badge, card, listStyle } from "../guide/parts.js";
import { UnauthorizedError } from "../guide/types.js";
import { useHost } from "./context.js";
import {
  ConflictError,
  REQUEST_STATUSES,
  STAFF_TRANSITIONS,
  type RequestStatus,
  type ServiceRequest,
} from "./types.js";

const statusKey = (s: RequestStatus) => `miniapp.requestStatus.${s}` as MessageKey;

function useDate(): (iso: string) => string {
  const { locale } = useT();
  return (iso) => {
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
        new Date(iso),
      );
    } catch {
      return iso;
    }
  };
}

function RequestInfo({ r }: { r: ServiceRequest }) {
  const { t, locale } = useT();
  const date = useDate();
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
      {r.comment && <span style={{ display: "block", whiteSpace: "pre-line" }}>{r.comment}</span>}
      {r.deferredUntil && r.status === "new" && (
        <span style={{ display: "block" }}>{t("miniapp.requests.deferred", { from: r.deferredUntil })}</span>
      )}
      <small style={{ display: "block" }}>{t("miniapp.requests.created", { date: date(r.createdAt) })}</small>
    </>
  );
}

function AuthAware({ error, children }: { error: unknown; children: React.ReactNode }) {
  const { t } = useT();
  if (error instanceof UnauthorizedError)
    return (
      <p role="alert" data-testid="requests-auth">
        {t("miniapp.auth.again")}
      </p>
    );
  return <>{children}</>;
}

export function MyRequests() {
  const { t } = useT();
  const { signedIn } = useGuide();
  const { api } = useHost();
  const [list, retry] = useAsync(() => (signedIn ? api.myRequests() : Promise.resolve([])), [api, signedIn]);
  return (
    <Stack>
      <h1>{t("miniapp.requests.title")}</h1>
      {!signedIn ? (
        <p data-testid="requests-login">{t("miniapp.request.needsLogin")}</p>
      ) : (
        <AuthAware error={list.status === "error" ? list.error : null}>
          <AsyncView state={list} retry={retry}>
            {(items) =>
              items.length ? (
                <ul style={listStyle} data-testid="my-requests">
                  {items.map((r) => (
                    <li key={r.id} style={card} data-testid="request-item">
                      <RequestInfo r={r} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p data-testid="requests-empty">{t("miniapp.requests.empty")}</p>
              )
            }
          </AsyncView>
        </AuthAware>
      )}
    </Stack>
  );
}

const select: CSSProperties = {
  padding: 8,
  fontSize: "1rem",
  color: "var(--color-text)",
  background: "var(--color-bg)",
  border: "1px solid var(--color-hint)",
  borderRadius: "var(--radius)",
};

export function StaffRequests() {
  const { t } = useT();
  const { api, staff } = useHost();
  const [filter, setFilter] = useState<RequestStatus | "">("");
  const [list, retry] = useAsync(
    () => (staff ? api.staffRequests(filter || null) : Promise.resolve([])),
    [api, staff, filter],
  );
  const [message, setMessage] = useState<{ text: string; alert: boolean } | null>(null);
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
  const change = async (r: ServiceRequest, to: RequestStatus) => {
    setBusyId(r.id);
    setMessage(null);
    try {
      await api.setStatus(r.id, to);
      setMessage({ text: t("miniapp.staff.changed", { status: t(statusKey(to)) }), alert: false });
      retry();
    } catch (err) {
      if (err instanceof ConflictError) {
        setMessage({ text: t("miniapp.staff.conflict"), alert: true });
        retry();
      } else setMessage({ text: t("miniapp.staff.error"), alert: true });
    } finally {
      setBusyId(null);
    }
  };
  return (
    <Stack>
      <h1>{t("miniapp.staff.title")}</h1>
      <label>
        {t("miniapp.staff.filter")}{" "}
        <select
          style={select}
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
      <p role={message?.alert ? "alert" : "status"} data-testid="staff-message">
        {message?.text ?? ""}
      </p>
      <AuthAware error={list.status === "error" ? list.error : null}>
        <AsyncView state={list} retry={retry}>
          {(items) =>
            items.length ? (
              <ul style={listStyle} data-testid="staff-requests">
                {items.map((r) => (
                  <li key={r.id} style={card} data-testid="staff-request">
                    <RequestInfo r={r} />
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                      {STAFF_TRANSITIONS[r.status].map((to) => (
                        <Button key={to} disabled={busyId === r.id} onClick={() => void change(r, to)}>
                          {t(`miniapp.staff.to.${to}` as MessageKey)}
                        </Button>
                      ))}
                    </div>
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
