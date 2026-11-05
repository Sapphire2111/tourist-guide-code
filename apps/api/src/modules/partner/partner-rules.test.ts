import { describe, expect, it } from "vitest";
import { canAssignRole } from "../role-assignments/index.js";
import { organizationName } from "./partner.service.js";
import {
  abilitiesOf,
  DECISION_PLACE_STATUS,
  higherRole,
  inviteState,
  isPartnerEditable,
  isSubmittable,
  missingFields,
  normalizeInviteToken,
  changedIdentityFields,
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
      managePriceList: false,
      serviceRequests: true,
      bookings: true,
      manualBooking: true,
      manageResources: false,
      editAvailability: false,
      manualAvailability: true,
      customerPhone: false,
    });
    expect(abilitiesOf("ORG_MANAGER")).toMatchObject({
      editPlace: true,
      editIdentity: false,
      submit: false,
      manageStaff: false,
      manageOffers: true,
      managePriceList: true,
      bookings: true,
      manualBooking: true,
      manageResources: true,
      editAvailability: true,
      manualAvailability: true,
      customerPhone: true,
    });
    expect(Object.values(abilitiesOf("ORG_OWNER")).every(Boolean)).toBe(true);
    expect(higherRole("ORG_STAFF", "ORG_OWNER")).toBe("ORG_OWNER");
    expect(
      touchedIdentityFields({ name: { uk: "x" }, phone: "+1", location: null, localityId: null }),
    ).toEqual(["localityId", "name", "location"]);
  });

  it("поля личности: изменение сравнивается с текущими значениями, а не с фактом передачи", () => {
    const current = {
      categoryId: "0190F5C2-7D3E-7000-8000-000000000001",
      localityId: null,
      name: { uk: "Хата", en: "Hut" },
      address: null,
      location: { lon: 24.5, lat: 48.4 },
    };
    expect(
      changedIdentityFields(
        {
          categoryId: "0190f5c2-7d3e-7000-8000-000000000001",
          localityId: null,
          name: { en: "Hut", uk: " Хата " },
          address: null,
          location: { lon: 24.50000005, lat: 48.4 },
        },
        current,
      ),
    ).toEqual([]);
    expect(
      changedIdentityFields(
        {
          localityId: "0190f5c2-7d3e-7000-8000-000000000002",
          name: { uk: "Хата" },
          address: { uk: "вул. 1" },
          location: { lon: 24.5001, lat: 48.4 },
        },
        current,
      ),
    ).toEqual(["localityId", "name", "address", "location"]);
    expect(changedIdentityFields({ location: null }, current)).toEqual(["location"]);
    expect(changedIdentityFields({ location: null }, { ...current, location: null })).toEqual([]);
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

  it("название организации: до 200 символов по кодпоинтам, пробелы по краям убираются", () => {
    expect(organizationName("  Хата  ")).toBe("Хата");
    expect(organizationName("Ї".repeat(250))).toBe("Ї".repeat(200));
    expect(Array.from(organizationName("😀".repeat(201))).length).toBe(200);
  });

  it("период акции: конец позже начала, края необязательны", () => {
    expect(validOfferPeriod(null, null)).toBe(true);
    expect(validOfferPeriod("2026-11-03T00:00:00Z", null)).toBe(true);
    expect(validOfferPeriod("2026-11-03T00:00:00Z", "2026-11-03T00:00:00Z")).toBe(false);
    expect(validOfferPeriod("2026-11-03T00:00:00Z", "2026-11-04T00:00:00Z")).toBe(true);
  });
});
