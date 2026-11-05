import { describe, expect, it } from "vitest";
import { roleHasPermission } from "../rbac/index.js";
import {
  AUTO_REJECT_COMMENT,
  CLAIM_DECISION_STATUS,
  claimBlocker,
  claimDecisionText,
  claimOrganization,
  DECIDED_CLAIM_STATUSES,
  isClaimDecidable,
  templateForCategory,
} from "./claim-rules.js";

const ORG = "0190f5c2-7d3e-7000-8000-0000000000aa";

describe("заявка «Це мій заклад» (0031): правила", () => {
  it("заявить можно только опубликованное место без организации", () => {
    expect(claimBlocker({ status: "published", organization_id: null })).toBeNull();
    expect(claimBlocker({ status: "published", organization_id: ORG })).toBe("place_claimed");
    // Организация важнее статуса: у места партнёра ссылки нет вовсе.
    expect(claimBlocker({ status: "draft", organization_id: ORG })).toBe("place_claimed");
    for (const status of ["draft", "suspended", "archived", "pending_moderation"] as const)
      expect(claimBlocker({ status, organization_id: null })).toBe("place_not_published");
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
    for (const s of ["approved", "rejected", "withdrawn"] as const) expect(isClaimDecidable(s)).toBe(false);
    expect(CLAIM_DECISION_STATUS).toEqual({ approve: "approved", reject: "rejected" });
    expect([...DECIDED_CLAIM_STATUSES].sort()).toEqual(["approved", "rejected", "withdrawn"]);
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
    expect(templateForCategory(templates, null)).toBeNull();
  });

  it("решают модератор, админ региона и суперадмин; партнёр — нет", () => {
    for (const role of ["MODERATOR", "REGION_ADMIN", "SUPERADMIN"])
      expect(roleHasPermission(role, "place_claim.decide")).toBe(true);
    for (const role of ["ORG_OWNER", "ORG_MANAGER", "ORG_STAFF"])
      expect(roleHasPermission(role, "place_claim.decide")).toBe(false);
  });

  it("текст уведомления заявителю: решение и комментарий модератора", () => {
    expect(claimDecisionText("approve", "Кав'ярня", null)).toBe(
      "Заявку «Це мій заклад» на «Кав'ярня» схвалено. Заклад тепер у вашому кабінеті партнера.",
    );
    expect(claimDecisionText("reject", "Кав'ярня", "Не дозвонились")).toBe(
      "Заявку «Це мій заклад» на «Кав'ярня» відхилено. Коментар модератора: Не дозвонились",
    );
    expect(claimDecisionText("reject", "X", AUTO_REJECT_COMMENT)).toContain(AUTO_REJECT_COMMENT);
  });
});
