// Сборка AppModule (без соединения с БД: пул pg подключается при первом запросе): RBAC берёт принципала из сессий
// (T1-26), а не из заглушки NoPrincipalSource — иначе все защищённые эндпоинты молча отвечали бы 401.
import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "./app.module.js";
import { SessionPrincipalSource } from "./modules/auth/index.js";
import { PRINCIPAL_SOURCE } from "./modules/rbac/index.js";

describe("AppModule", () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot({ DATABASE_URL: "postgres://u:p@127.0.0.1:1/db" })],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it("PRINCIPAL_SOURCE — SessionPrincipalSource из AuthModule", () => {
    const source = moduleRef.get(PRINCIPAL_SOURCE, { strict: false });
    expect(source).toBeInstanceOf(SessionPrincipalSource);
    expect(source).toBe(moduleRef.get(SessionPrincipalSource, { strict: false }));
  });
});
