// Скан QR из открытого Mini App: текст → разбор (qr-link.ts) → тот же GET /context/{код}, что и при входе по QR.
import type { ApiClient } from "@tg/api-client";
import type { MessageKey } from "@tg/i18n";
import { parseQrText } from "./qr-link.js";
import { fetchContext, type QrContext } from "./session.js";

export type ScanOutcome =
  | { kind: "context"; context: QrContext }
  | { kind: "invite"; token: string }
  | { kind: "message"; messageKey: MessageKey };

export async function resolveScan(api: ApiClient, text: string): Promise<ScanOutcome> {
  const scan = parseQrText(text);
  if (scan.kind === "foreign") return { kind: "message", messageKey: "miniapp.scan.foreign" };
  if (scan.kind === "invite") return { kind: "invite", token: scan.token };
  const context = await fetchContext(api, scan.code);
  if (!context) return { kind: "message", messageKey: "miniapp.scan.failed" };
  if (context.status === "ok") return { kind: "context", context };
  if (context.status === "inactive") return { kind: "message", messageKey: "miniapp.scan.inactive" };
  return { kind: "message", messageKey: "miniapp.scan.foreign" };
}
