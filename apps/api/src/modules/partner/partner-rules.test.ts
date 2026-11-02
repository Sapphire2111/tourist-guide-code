import { describe, expect, it } from "vitest";
import { canAssignRole } from "../role-assignments/index.js";
import {
  abilitiesOf,
  DECISION_PLACE_STATUS,
  higherRole,
  inviteState,
  isPartnerEditable,
  isSubmittable,
  missingFields,
  normalizeInviteToken,
  touchedIdentityFields,
  validOfferPeriod,
  type PlaceFill,
} from "./partner-rules.js";

const EMPTY: PlaceFill = {
  name: { uk: "Хата" },
  categoryId: "c",
  description: null,
  address: { uk: "  " },
  hasLocation: false,
  phone: null,
  weeklyIntervals: 0,
  photos: 0,
};

describe("правила кабинета партнёра (блок 6)", () => {
  it("обязательные поля шаблона: пустые и пробельные тексты — незаполнены, порядок как в шаблоне", () => {
    const required = [
      "name",
      "category",
      "description",
      "address",
      "location",
      "phone",
      "schedule",
      "photo",
    ] as const;
    expect(missingFields(required, EMPTY)).toEqual([
      "description",
      "address",
      "location",
      "phone",
      "schedule",
      "photo",
    ]);
    expect(
      missingFields(required, {
        ...EMPTY,
        description: { uk: "Опис" },
        address: { uk: "вул. 1" },
        hasLocation: true,
        phone: "+380501112233",
        weeklyIntervals: 7,
        photos: 1,
      }),
    ).toEqual([]);
    expect(missingFields(["name", "photo"], EMPTY)).toEqual(["photo"]);
  });

  it("правка и отправка: на модерации, приостановлено и архив — только чтение; повторная подача из возврата и отказа", () => {
    expect(
      ["draft", "changes_requested", "rejected", "published"].every((s) => isPartnerEditable(s as never)),
    ).toBe(true);
    expect(["pending_moderation", "suspended", "archived"].some((s) => isPartnerEditable(s as never))).toBe(
      false,
    );
    expect(isSubmittable("changes_requested")).toBe(true);
    expect(isSubmittable("published")).toBe(false);
    expect(isSubmittable("pending_moderation")).toBe(false);
    expect(DECISION_PLACE_STATUS).toEqual({
      approve: "published",
      reject: "rejected",
      changes_requested: "changes_requested",
    });
  });

  it("роли: кассир — без редактора, сотрудников и акций; менеджер — без полей личности и сотрудников; владелец — всё", () => {
    expect(abilitiesOf("ORG_STAFF")).toEqual({
      editPlace: false,
      editIdentity: false,
      submit: false,
      manageStaff: false,
      manageOffers: false,
      serviceRequests: true,
    });
    expect(abilitiesOf("ORG_MANAGER")).toMatchObject({
      editPlace: true,
      editIdentity: false,
      submit: false,
      manageStaff: false,
      manageOffers: true,
    });
    expect(Object.values(abilitiesOf("ORG_OWNER")).every(Boolean)).toBe(true);
    expect(higherRole("ORG_STAFF", "ORG_OWNER")).toBe("ORG_OWNER");
    expect(touchedIdentityFields({ name: { uk: "x" }, phone: "+1", location: null })).toEqual([
      "name",
      "location",
    ]);
  });

  it("назначение ролей: владелец — только менеджера и кассира; менеджер и кассир — никого", () => {
    expect(canAssignRole("ORG_OWNER", "ORG_MANAGER")).toBe(true);
    expect(canAssignRole("ORG_OWNER", "ORG_STAFF")).toBe(true);
    expect(canAssignRole("ORG_OWNER", "ORG_OWNER")).toBe(false);
    expect(canAssignRole("ORG_OWNER", "MODERATOR")).toBe(false);
    expect(canAssignRole("ORG_MANAGER", "ORG_STAFF")).toBe(false);
    expect(canAssignRole("ORG_STAFF", "ORG_STAFF")).toBe(false);
    expect(canAssignRole("REGION_ADMIN", "ORG_MANAGER")).toBe(true);
  });

  it("приглашение: состояние по времени и отметкам; токен — 43 символа base64url, префикс inv_ снимается", () => {
    const now = new Date("2026-11-02T12:00:00Z");
    const base = { accepted_at: null, revoked_at: null, expires_at: new Date("2026-11-05T12:00:00Z") };
    expect(inviteState(base, now)).toBe("active");
    expect(inviteState({ ...base, expires_at: now }, now)).toBe("expired");
    expect(inviteState({ ...base, accepted_at: now }, now)).toBe("accepted");
    expect(inviteState({ ...base, revoked_at: now }, now)).toBe("revoked");
    const token = "A".repeat(42) + "_";
    expect(normalizeInviteToken(token, "inv_")).toBe(token);
    expect(normalizeInviteToken(`inv_${token}`, "inv_")).toBe(token);
    expect(normalizeInviteToken("short", "inv_")).toBeUndefined();
    expect(normalizeInviteToken(`${token}!`, "inv_")).toBeUndefined();
  });

  it("период акции: конец позже начала, края необязательны", () => {
    expect(validOfferPeriod(null, null)).toBe(true);
    expect(validOfferPeriod("2026-11-03T00:00:00Z", null)).toBe(true);
    expect(validOfferPeriod("2026-11-03T00:00:00Z", "2026-11-03T00:00:00Z")).toBe(false);
    expect(validOfferPeriod("2026-11-03T00:00:00Z", "2026-11-04T00:00:00Z")).toBe(true);
  });
});
