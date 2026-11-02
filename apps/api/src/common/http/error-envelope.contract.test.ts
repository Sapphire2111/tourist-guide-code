import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  type INestApplication,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Type } from "class-transformer";
import { IsEmail, IsInt, Min, ValidateNested } from "class-validator";
import request from "supertest";
import type { ErrorEnvelope } from "@tg/shared";
import { configureApp } from "../../bootstrap/configure-app.js";
// CursorQueryDto нужен в рантайме: emitDecoratorMetadata передаёт класс в ValidationPipe (import type сломает валидацию).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ApiError, CursorQueryDto } from "./index.js";

class ItemDto {
  @IsInt() @Min(1) qty!: number;
}

class CreateDto {
  @IsEmail() email!: string;
  @ValidateNested() @Type(() => ItemDto) item!: ItemDto;
}

@Controller("contract")
class ContractController {
  @Post()
  create(@Body() dto: CreateDto): { email: string } {
    return { email: dto.email };
  }

  @Get("list")
  list(@Query() q: CursorQueryDto): { items: never[]; nextCursor: null; limit: number | undefined } {
    return { items: [], nextCursor: null, limit: q.limit };
  }

  @Get("forbidden")
  forbidden(): never {
    throw new ForbiddenException("секрет не должен утечь");
  }

  @Get("conflict")
  conflict(): never {
    throw new ApiError("CONFLICT", { messageKey: "errors.test.taken", details: { resource: "slot" } });
  }

  @Get("unavailable")
  unavailable(): never {
    throw new ServiceUnavailableException();
  }

  @Get("foreign-status")
  foreignStatus(): never {
    throw Object.assign(new Error("ошибка библиотеки"), { status: 404 });
  }

  @Get("boom")
  boom(): never {
    throw new Error("внутренняя деталь /etc/secret");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function expectEnvelope(
  res: request.Response,
  status: number,
  code: string,
  messageKey: string,
): ErrorEnvelope {
  expect(res.status).toBe(status);
  const body = res.body as ErrorEnvelope;
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error.code).toBe(code);
  expect(body.error.messageKey).toBe(messageKey);
  expect(body.error.correlationId).toBe(res.headers["x-request-id"]);
  return body;
}

describe("контракт ошибок API (единый конверт + correlation id)", () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ContractController] }).compile();
    app = configureApp(moduleRef.createNestApplication(), { appEnv: "prod" });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("валидация DTO → 400 VALIDATION_FAILED с ошибками по полям, включая вложенные", async () => {
    const res = await http()
      .post("/contract")
      .send({ email: "не-почта", item: { qty: 0 }, extra: 1 });
    const body = expectEnvelope(res, 400, "VALIDATION_FAILED", "errors.validation");
    expect(body.error.details?.fields).toEqual(
      expect.arrayContaining([
        { field: "email", constraint: "isEmail", messageKey: "errors.validation.isEmail" },
        { field: "item.qty", constraint: "min", messageKey: "errors.validation.min" },
        {
          field: "extra",
          constraint: "whitelistValidation",
          messageKey: "errors.validation.whitelistValidation",
        },
      ]),
    );
  });

  it("валидный запрос проходит, query-параметры пагинации приводятся к типам", async () => {
    await http()
      .post("/contract")
      .send({ email: "a@b.ua", item: { qty: 2 } })
      .expect(201);
    const res = await http().get("/contract/list?limit=5").expect(200);
    expect(res.body).toEqual({ items: [], nextCursor: null, limit: 5 });
    const bad = await http().get("/contract/list?limit=500");
    expect(
      expectEnvelope(bad, 400, "VALIDATION_FAILED", "errors.validation").error.details?.fields?.[0]?.field,
    ).toBe("limit");
  });

  it("битый JSON → 400 BAD_REQUEST", async () => {
    const res = await http().post("/contract").set("content-type", "application/json").send("{oops");
    expectEnvelope(res, 400, "BAD_REQUEST", "errors.badRequest");
  });

  it("неизвестный маршрут → 404 NOT_FOUND", async () => {
    expectEnvelope(await http().get("/nope"), 404, "NOT_FOUND", "errors.notFound");
  });

  it("ForbiddenException → 403 FORBIDDEN без текста исключения", async () => {
    const res = await http().get("/contract/forbidden");
    expectEnvelope(res, 403, "FORBIDDEN", "errors.forbidden");
    expect(JSON.stringify(res.body)).not.toContain("секрет");
  });

  it("ApiError CONFLICT → 409 со своим messageKey и details", async () => {
    const body = expectEnvelope(await http().get("/contract/conflict"), 409, "CONFLICT", "errors.test.taken");
    expect(body.error.details).toEqual({ resource: "slot" });
  });

  it("неизвестная ошибка → 500 INTERNAL без сообщения и стека", async () => {
    const log = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const res = await http().get("/contract/boom");
    const body = expectEnvelope(res, 500, "INTERNAL", "errors.internal");
    expect(body.error.details).toBeUndefined();
    expect(res.text).not.toMatch(/secret|внутренняя|at /);
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain(body.error.correlationId);
  });

  it("HttpException 503 → 503 SERVICE_UNAVAILABLE, а не 500; в лог — warn с correlationId", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const body = expectEnvelope(
      await http().get("/contract/unavailable"),
      503,
      "SERVICE_UNAVAILABLE",
      "errors.serviceUnavailable",
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain(body.error.correlationId);
  });

  it("status у ошибки не из Nest и не из body-parser игнорируется → 500", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    expectEnvelope(await http().get("/contract/foreign-status"), 500, "INTERNAL", "errors.internal");
  });

  it("correlation id берётся из X-Request-Id, небезопасный — заменяется на UUID", async () => {
    const own = await http().get("/nope").set("X-Request-Id", "req-123.abc");
    expect(own.headers["x-request-id"]).toBe("req-123.abc");
    expect((own.body as ErrorEnvelope).error.correlationId).toBe("req-123.abc");

    const unsafe = await http().get("/nope").set("X-Request-Id", "evil\tinjected");
    expect(unsafe.headers["x-request-id"]).toMatch(UUID);
  });

  it("успешный ответ тоже несёт X-Request-Id", async () => {
    const res = await http().get("/contract/list").expect(200);
    expect(res.headers["x-request-id"]).toMatch(UUID);
  });

  it("при APP_ENV=prod Swagger UI и /openapi.json не публикуются", async () => {
    await http().get("/openapi.json").expect(404);
    await http().get("/docs").expect(404);
  });
});
