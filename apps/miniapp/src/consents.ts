// Версии текстов согласий — каркас: тексты и policy_documents решаются в D-41, до тех пор версия-константа.
// Смена версии → C01 снова попросит принять документ.
import type { Me } from "./session.js";

export const CONSENT_VERSIONS = {
  terms: "2026-11-01-draft",
  privacy: "2026-11-01-draft",
} as const;

/** Обязательные согласия (terms, privacy) действующей версии приняты. */
export function hasRequiredConsents(me: Me): boolean {
  return (Object.keys(CONSENT_VERSIONS) as (keyof typeof CONSENT_VERSIONS)[]).every((kind) =>
    me.consents.some(
      (c) => c.kind === kind && c.version === CONSENT_VERSIONS[kind] && c.status === "accepted",
    ),
  );
}

export function messagingGranted(me: Me, purpose: "service" | "marketing"): boolean {
  return me.messagingConsents.some((c) => c.purpose === purpose && c.granted);
}
