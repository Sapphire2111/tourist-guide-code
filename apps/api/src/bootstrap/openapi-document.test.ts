import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../app.module.js";
import { configureApp } from "./configure-app.js";
import { buildOpenApiDocument } from "./openapi-document.js";

describe("OpenAPI-контракт", () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Модуль БД (T1-08): пул ленивый — соединения в тесте не открываются.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot({ DATABASE_URL: "postgres://u:p@127.0.0.1:1/db" })],
    }).compile();
    app = configureApp(moduleRef.createNestApplication(), { appEnv: "local" });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("описывает /health с ответом 200 и ошибками в едином конверте", () => {
    const doc = buildOpenApiDocument(app);
    const op = doc.paths["/health"]?.get;
    expect(op?.operationId).toBe("getHealth");
    expect(Object.keys(op?.responses ?? {})).toEqual(expect.arrayContaining(["200", "400", "500"]));
    expect(doc.components?.schemas).toHaveProperty("ErrorEnvelopeDto");
  });

  it("схема безопасности session — http bearer без bearerFormat JWT (токен непрозрачный)", () => {
    const scheme = buildOpenApiDocument(app).components?.securitySchemes?.session;
    expect(scheme).toMatchObject({ type: "http", scheme: "bearer" });
    expect(scheme).not.toHaveProperty("bearerFormat");
  });

  it("закоммиченный apps/api/openapi.json совпадает с кодом (иначе: pnpm api:generate)", async () => {
    const committed: unknown = JSON.parse(
      await readFile(new URL("../../openapi.json", import.meta.url), "utf8"),
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument(app))));
  });

  it("Promotion: эндпоинтов и схем размещения нет (до D-63); наружу — только метка AdLabel каталога гида (ADR-0019)", () => {
    const doc = buildOpenApiDocument(app);
    expect(Object.keys(doc.paths).filter((p) => /promot|placement|sponsor/i.test(p))).toEqual([]);
    const schemas = Object.keys(doc.components?.schemas ?? {});
    expect(schemas.filter((s) => /promot|placement|sponsor|advert/i.test(s) || /^Ad[A-Z]/.test(s))).toEqual([
      "AdLabel",
    ]);
    // AdLabel — только перечисление меток; поля с ним — adLabel в выдаче гида.
    expect(doc.components?.schemas?.AdLabel).toMatchObject({
      type: "string",
      enum: ["advertising", "partner"],
    });
  });

  it("вне prod отдаёт /openapi.json и Swagger UI", async () => {
    const res = await request(app.getHttpServer()).get("/openapi.json").expect(200);
    expect((res.body as { paths: object }).paths).toHaveProperty("/health");
    await request(app.getHttpServer()).get("/docs").expect(200);
  });
});
