// Общие элементы экранов брони: бейдж статуса, причина, текст ошибки, ключ идемпотентности на тело запроса.
import { useRef } from "react";
import type { MessageKey } from "@tg/i18n";
import { useT } from "@tg/ui";
import { Badge } from "../guide/parts.js";
import { useErrorText } from "../host/errors.js";
import { ApiCallError, NetworkError } from "../host/types.js";
import { keepsIdempotencyKey } from "../partner/partner-api.js";
import { newKey } from "../partner/parts.js";
import type { BookingStatus } from "./bookings-api.js";
import { reasonText, STATUS_TONE, statusKey } from "./format.js";

export function StatusBadge({ status, who }: { status: BookingStatus; who: "user" | "partner" }) {
  const { t } = useT();
  return (
    <Badge testId="booking-status" tone={STATUS_TONE[status]}>
      {t(statusKey(status, who))}
    </Badge>
  );
}

export function Reason({ reason }: { reason: string | null }) {
  const { t } = useT();
  const text = reasonText(reason, t);
  if (!text) return null;
  return (
    <p className="kosiv-muted" data-testid="booking-reason">
      {t("miniapp.booking.reasonLabel", { reason: text })}
    </p>
  );
}

/** Текст ошибки брони: «не пізніше ніж за N год», сеть, 403 «немає прав», известный messageKey сервера, иначе запасной. */
export function useBookingErrorText(): (err: unknown, fallback: MessageKey) => string {
  const { t } = useT();
  const base = useErrorText();
  return (err, fallback) => {
    if (err instanceof ApiCallError && err.messageKey === "errors.booking.cancelTooLate") {
      const hours = Number(err.details?.beforeStartHours);
      return hours > 0
        ? t("miniapp.booking.cancelTooLate", { hours })
        : t("miniapp.booking.cancelTooLateStarted");
    }
    if (err instanceof NetworkError) return t("miniapp.booking.network");
    if (err instanceof ApiCallError && err.status === 403) return t("miniapp.booking.forbidden");
    return base(err, fallback);
  };
}

/**
 * Ключ Idempotency-Key на тело запроса: повтор того же тела после неясного исхода (сеть, 5xx) — тот же ключ;
 * другое тело или окончательный ответ (4xx) — новый.
 */
export function useIdempotencyKey(): { keyFor: (body: unknown) => string; settle: (err?: unknown) => void } {
  const ref = useRef<{ key: string; body: string } | null>(null);
  return {
    keyFor: (body) => {
      const json = JSON.stringify(body);
      if (ref.current?.body !== json) ref.current = { key: newKey(), body: json };
      return ref.current.key;
    },
    settle: (err) => {
      if (err === undefined || !keepsIdempotencyKey(err)) ref.current = null;
    },
  };
}
