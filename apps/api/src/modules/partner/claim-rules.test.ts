import { describe, expect, it } from "vitest";
import { roleHasPermission } from "../rbac/index.js";
import {
  AUTO_REJECT_COMMENT,
  CLAIM_DECISION_STATUS,
  claimBlocker,
  claimDecisionText,
  claimOrganization,
  DECIDED_CLAIM_STATUSES,
  isClaimableCategory,
  isClaimDecidable,
  isClaimRevocable,
  isClaimWithdrawable,
  isRecentClaim,
  templateForCategory,
} from "./claim-rules.js";

const ORG = "0190f5c2-7d3e-7000-8000-0000000000aa";

describe("заявка «Це мій заклад» (0031): правила", () => {
  it("заявить можно только опубликованное место без организации в категории с хозяином-бизнесом", () => {
    expect(claimBlocker({ status: "published", organization_id: null }, "cafes")).toBeNull();
    expect(claimBlocker({ status: "published", organization_id: ORG }, "cafes")).toBe("place_claimed");
    // Организация важнее статуса: у места партнёра ссылки нет вовсе.
    expect(claimBlocker({ status: "draft", organization_id: ORG }, "cafes")).toBe("place_claimed");
    for (const status of ["draft", "suspended", "archived", "pending_moderation"] as const)
      expect(claimBlocker({ status, organization_id: null }, "cafes")).toBe("place_not_published");
    expect(claimBlocker({ status: "published", organization_id: null }, "peaks")).toBe("not_claimable");
    expect(claimBlocker({ status: "published", organization_id: null }, null)).toBe("not_claimable");
  });

  it("категории: природа, вершины, пам'ятки, лікарні, банкомати — не заявляются; бизнесы — да", () => {
    for (const code of ["nature", "peaks", "sights", "hospitals", "atm", "post", "parking", "help"])
      expect(isClaimableCategory(code)).toBe(false);
    for (const code of [
      "hotels",
      "sadyby",
      "cafes",
      "restaurants",
      "chany",
      "ski-lifts",
      "ski-resorts",
      "ski-rental",
      "gear-rental",
      "rental",
      "stores",
      "souvenirs",
      "car-service",
      "ev-charging",
      "pharmacies",
    ])
      expect(isClaimableCategory(code)).toBe(true);
  });

  it("организация: ровно одно — своя (ORG_OWNER) или новая по названию", () => {
    const owner = new Set([ORG]);
    expect(claimOrganization({ organizationId: ORG.toUpperCase() }, owner)).toEqual({
      kind: "existing",
      organizationId: ORG,
    });
    expect(claimOrganization({ organizationName: "  ФОП Петренко  " }, owner)).toEqual({
      kind: "new",
      name: "ФОП Петренко",
    });
    expect(claimOrganization({}, owner)).toBe("organization_choice_required");
    expect(claimOrganization({ organizationName: "   " }, owner)).toBe("organization_choice_required");
    expect(claimOrganization({ organizationId: ORG, organizationName: "X" }, owner)).toBe(
      "organization_choice_required",
    );
    // Менеджер/кассир чужой организации (нет ORG_OWNER) — не может заявить место на неё.
    expect(claimOrganization({ organizationId: ORG }, new Set())).toBe("not_org_owner");
  });

  it("переходы: решать можно только заявку на рассмотрении; одобрение → approved, отказ → rejected", () => {
    expect(isClaimDecidable("pending")).toBe(true);
    expect(isClaimWithdrawable("pending")).toBe(true);
    expect(isClaimWithdrawable("approved")).toBe(false);
    expect(isClaimRevocable("approved")).toBe(true);
    for (const s of ["pending", "rejected", "withdrawn", "revoked"] as const)
      expect(isClaimRevocable(s)).toBe(false);
    for (const s of ["approved", "rejected", "withdrawn", "revoked"] as const)
      expect(isClaimDecidable(s)).toBe(false);
    expect(CLAIM_DECISION_STATUS).toEqual({ approve: "approved", reject: "rejected" });
    expect([...DECIDED_CLAIM_STATUSES].sort()).toEqual(["approved", "rejected", "revoked", "withdrawn"]);
  });

  it("шаблон для места каталога — по коду категории, первый по sort_order; нет — null", () => {
    const templates = [
      { code: "food", category_codes: ["cafes", "restaurants"], sort_order: 20 },
      { code: "hotel", category_codes: ["hotels", "sadyby"], sort_order: 10 },
      { code: "spa", category_codes: ["spa", "hotels"], sort_order: 30 },
    ];
    expect(templateForCategory(templates, "hotels")?.code).toBe("hotel");
    expect(templateForCategory(templates, "cafes")?.code).toBe("food");
    expect(templateForCategory(templates, "museums")).toBeNull();
    // Базовый шаблон (category_codes '*') — для любой другой категории.
    const withBase = [...templates, { code: "base", category_codes: ["*"], sort_order: 1000 }];
    expect(templateForCategory(withBase, "ski-lifts")?.code).toBe("base");
    expect(templateForCategory(withBase, "hotels")?.code).toBe("hotel");
    expect(templateForCategory(withBase, null)?.code).toBe("base");
  });

  it("решают модератор, админ региона и суперадмин; партнёр — нет", () => {
    for (const role of ["MODERATOR", "REGION_ADMIN", "SUPERADMIN"])
      expect(roleHasPermission(role, "place_claim.decide")).toBe(true);
    for (const role of ["ORG_OWNER", "ORG_MANAGER", "ORG_STAFF"])
      expect(roleHasPermission(role, "place_claim.decide")).toBe(false);
  });

  it("текст уведомления заявителю: решение и комментарий модератора", () => {
    expect(claimDecisionText("approve", "Кав'ярня", null)).toBe(
      "Заявку «Це мій заклад» на «Кав'ярня» схвалено. Заклад тепер у розділі «Мій заклад».",
    );
    expect(claimDecisionText("reject", "Кав'ярня", "Не дозвонились")).toBe(
      "Заявку «Це мій заклад» на «Кав'ярня» відхилено. Коментар модератора: Не дозвонились",
    );
    expect(claimDecisionText("reject", "X", AUTO_REJECT_COMMENT)).toContain(AUTO_REJECT_COMMENT);
  });

  it("«Мої заявки»: на рассмотрении — всегда, решённые — 30 дней", () => {
    const now = new Date("2026-11-30T00:00:00Z");
    const old = new Date("2026-10-01T00:00:00Z");
    expect(isRecentClaim({ status: "pending", updated_at: old }, now)).toBe(true);
    expect(isRecentClaim({ status: "rejected", updated_at: old }, now)).toBe(false);
    expect(isRecentClaim({ status: "approved", updated_at: new Date("2026-11-20T00:00:00Z") }, now)).toBe(
      true,
    );
  });
});
