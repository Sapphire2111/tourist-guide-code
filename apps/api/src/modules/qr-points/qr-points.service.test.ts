// Unit: QrPointsService без HTTP — повтор генерации кода при конфликте, ссылка печати по имени бота.
import { describe, expect, it } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import { regionContext, withTenant, type QrPoint } from "../../db/index.js";
import type { AuditService } from "../audit/index.js";
import type { QrPointsRepository } from "./qr-points.repository.js";
import { buildDeepLink, QrPointError, QrPointsService, renderQrSvg } from "./qr-points.service.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const meta = { actor: { type: "system" as const } };

function service(insertResults: (QrPoint | undefined)[]) {
  const { db } = recordingDb();
  const codes: string[] = [];
  const repo = {
    insertIfCodeFree: (row: { code: string }) => {
      codes.push(row.code);
      return Promise.resolve(insertResults.shift());
    },
  } as unknown as QrPointsRepository;
  const audit = { record: () => Promise.resolve({}) } as unknown as AuditService;
  return { svc: new QrPointsService(db, repo, audit, {}), db, codes };
}

describe("QrPointsService.create", () => {
  it("занятый код — новый код; после 5 конфликтов — code_generation_failed", async () => {
    const point = { id: "p", region_id: A, code: "x" } as QrPoint;
    const ok = service([undefined, undefined, point]);
    await expect(
      withTenant(ok.db, regionContext(A), () =>
        ok.svc.create({ regionId: A, type: "region", label: "x" }, meta),
      ),
    ).resolves.toBe(point);
    expect(new Set(ok.codes).size).toBe(3);

    const fail = service([]);
    await expect(
      withTenant(fail.db, regionContext(A), () =>
        fail.svc.create({ regionId: A, type: "region", label: "x" }, meta),
      ),
    ).rejects.toMatchObject({ reason: "code_generation_failed" });
    expect(fail.codes).toHaveLength(5);
  });
});

describe("buildDeepLink / renderQrSvg", () => {
  it("ссылка основного Mini App бота; @ в начале допустим; без имени или с мусором — ошибка", () => {
    expect(buildDeepLink("tourist_bot", "demoHotel01")).toBe("https://t.me/tourist_bot?startapp=demoHotel01");
    expect(buildDeepLink("@tourist_bot", "a_b-c123456")).toBe(
      "https://t.me/tourist_bot?startapp=a_b-c123456",
    );
    for (const bad of [undefined, "", "bot", "bad name", "x".repeat(33)])
      expect(() => buildDeepLink(bad, "demoHotel01")).toThrow(QrPointError);
  });

  it("SVG — самодостаточная разметка без скриптов и внешних ссылок", () => {
    const svg = renderQrSvg("https://t.me/tourist_bot?startapp=demoHotel01");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+">/);
    expect(svg).not.toMatch(/<script|href=/i);
  });
});
