// Unit (без БД, Claude и Google не вызываются): HTTP-контракт ассистента — сессия, флаг module.assistant, валидация
// текста и контекста, rate limit, приём аудио (формат, размер), без ключей — 503, а не 500.
import type { INestApplication } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { ErrorEnvelope } from "@tg/shared";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { TenancyModule } from "../../common/tenancy/index.js";
import { DATABASE, DatabaseModule } from "../../db/index.js";
import { FeatureFlagsModule, FeatureFlagsService } from "../feature-flags/index.js";
import { GuideService } from "../guide/index.js";
import { RATE_LIMIT_RULE } from "../rate-limit/index.js";
import {
  PRINCIPAL_SOURCE,
  RbacModule,
  RbacTenantContextSource,
  RoleAssignmentsRepository,
} from "../rbac/index.js";
import {
  ASSISTANT_QUERY_RATE_LIMIT,
  ASSISTANT_TRANSCRIBE_RATE_LIMIT,
  AssistantController,
  audioMimeOf,
} from "./assistant.controller.js";
import { ASSISTANT_AUDIO_MAX_BYTES } from "./assistant.dto.js";
import { AssistantModule } from "./assistant.module.js";
import { AssistantService } from "./assistant.service.js";

const REGION = "0190f5c2-7d3e-7000-8000-00000000000a";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";
const LOCALITY = "0190f5c2-7d3e-7000-8000-000000000301";

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const result = {
  intent: {
    kind: "places",
    categories: ["cafes"],
    nameQuery: null,
    locality: null,
    radiusMeters: null,
    priceMin: null,
    priceMax: null,
    withKids: false,
    openNow: false,
    clarify: false,
    suggestions: ["cheaper"],
  },
  items: [],
  route: null,
  notes: [],
};

async function start(opts: { authenticated?: boolean; flagOn?: boolean; realService?: boolean } = {}) {
  const service = {
    query: vi.fn(() => Promise.resolve(result)),
    transcribe: vi.fn(() => Promise.resolve("кава поруч")),
  };
  const { db } = recordingDb({});
  let builder = Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
      TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
      FeatureFlagsModule.forRoot({ appEnv: "local" }),
      // Без ключей: настоящий сервис отвечает 503.
      AssistantModule.forRoot({}),
    ],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PRINCIPAL_SOURCE)
    .useValue({ resolve: () => (opts.authenticated === false ? undefined : { userId: USER }) })
    .overrideProvider(RoleAssignmentsRepository)
    .useValue({ activeGrantsOf: () => Promise.resolve([]) })
    .overrideProvider(FeatureFlagsService)
    .useValue({ isEnabled: vi.fn(() => Promise.resolve(opts.flagOn ?? true)) })
    // Каталог (MediaModule и др.) не поднимается: настоящий сервис до него не доходит без ключей.
    .overrideProvider(GuideService)
    .useValue({});
  if (!opts.realService) builder = builder.overrideProvider(AssistantService).useValue(service);
  const moduleRef = await builder.compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "local" });
  await app.init();
  return { http: () => request(app!.getHttpServer()), service };
}

const fields = (body: unknown) =>
  ((body as ErrorEnvelope).error.details as { fields?: { field: string }[] } | undefined)?.fields?.map(
    (f) => f.field,
  );

describe("POST /assistant/query", () => {
  it("реплика, точка и контекст диалога — сервису; ответ 200", async () => {
    const { http, service } = await start();
    const res = await http()
      .post("/assistant/query")
      .send({
        regionId: REGION,
        text: "  дешевше ",
        lat: 48.4,
        lng: 24.5,
        history: ["кав'ярня поруч", " "],
        previous: result.intent,
        localityIds: [LOCALITY],
      })
      .expect(200);
    expect(res.body).toEqual(result);
    expect(service.query).toHaveBeenCalledWith(REGION, USER, {
      text: "дешевше",
      origin: { lon: 24.5, lat: 48.4 },
      history: ["кав'ярня поруч"],
      previous: result.intent,
      localityIds: [LOCALITY],
    });
  });

  it("без сессии — 401; флаг выключен — 404", async () => {
    const anon = await start({ authenticated: false });
    await anon.http().post("/assistant/query").send({ regionId: REGION, text: "кава" }).expect(401);
    await app!.close();
    const off = await start({ flagOn: false });
    await off.http().post("/assistant/query").send({ regionId: REGION, text: "кава" }).expect(404);
    expect(off.service.query).not.toHaveBeenCalled();
  });

  it("валидация: длина текста, пустой текст, размер истории, чужие поля намерения, lat без lng", async () => {
    const { http, service } = await start();
    const post = (body: object) =>
      http()
        .post("/assistant/query")
        .send({ regionId: REGION, text: "кава", ...body });
    expect(fields((await post({ text: "x".repeat(301) }).expect(400)).body)).toEqual(["text"]);
    expect(fields((await post({ text: "   " }).expect(400)).body)).toEqual(["text"]);
    expect(fields((await post({ history: Array(6).fill("a") }).expect(400)).body)).toEqual(["history"]);
    await post({ previous: { ...result.intent, suggestions: ["hack"] } }).expect(400);
    await post({ previous: { ...result.intent, priceMax: 9 } }).expect(400);
    await post({ lat: 48.4 }).expect(400);
    await post({ localityIds: ["yaremche"] }).expect(400);
    await post({ localityIds: Array(11).fill(LOCALITY) }).expect(400);
    await post({ extra: 1 }).expect(400);
    expect(service.query).not.toHaveBeenCalled();
  });

  it("без ключа Claude — 503 errors.assistant.unavailable (не 500)", async () => {
    const { http } = await start({ realService: true });
    const res = await http().post("/assistant/query").send({ regionId: REGION, text: "кава" }).expect(503);
    expect((res.body as ErrorEnvelope).error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      messageKey: "errors.assistant.unavailable",
    });
  });
});

describe("POST /assistant/transcribe", () => {
  const post = (http: () => request.Agent, type: string, body: Buffer) =>
    http().post(`/assistant/transcribe?regionId=${REGION}`).set("Content-Type", type).send(body);

  it("Opus в webm/ogg — текст; формат с параметрами codecs", async () => {
    const { http, service } = await start();
    const res = await post(http as never, "audio/webm;codecs=opus", Buffer.from("OggS")).expect(200);
    expect(res.body).toEqual({ text: "кава поруч" });
    expect(service.transcribe).toHaveBeenCalledWith(REGION, USER, Buffer.from("OggS"), "audio/webm");
    await post(http as never, "audio/ogg", Buffer.from("OggS")).expect(200);
  });

  it("другой формат — 415; пусто — 400; больше предела — 413; без regionId — 400", async () => {
    const { http, service } = await start();
    const r415 = await post(http as never, "audio/mp4", Buffer.from("x")).expect(415);
    expect((r415.body as ErrorEnvelope).error.messageKey).toBe("errors.assistant.audioFormat");
    await post(http as never, "audio/webm", Buffer.alloc(0)).expect(400);
    const r413 = await post(http as never, "audio/webm", Buffer.alloc(ASSISTANT_AUDIO_MAX_BYTES + 1)).expect(
      413,
    );
    expect((r413.body as ErrorEnvelope).error.messageKey).toBe("errors.assistant.audioTooLarge");
    expect(r413.headers["connection"]).toBe("close");
    await http()
      .post("/assistant/transcribe")
      .set("Content-Type", "audio/webm")
      .send(Buffer.from("x"))
      .expect(400);
    expect(service.transcribe).not.toHaveBeenCalled();
  });

  it("без ключа Google — 503", async () => {
    const { http } = await start({ realService: true });
    await post(http as never, "audio/webm", Buffer.from("x")).expect(503);
  });
});

describe("лимиты", () => {
  it("свои rate limit на эндпоинты", () => {
    const reflector = new Reflector();
    const proto = AssistantController.prototype;
    expect(reflector.get(RATE_LIMIT_RULE, proto.query)).toEqual(ASSISTANT_QUERY_RATE_LIMIT);
    expect(reflector.get(RATE_LIMIT_RULE, proto.transcribe)).toEqual(ASSISTANT_TRANSCRIBE_RATE_LIMIT);
  });

  it("audioMimeOf", () => {
    expect(audioMimeOf("Audio/WebM; codecs=opus")).toBe("audio/webm");
    expect(audioMimeOf(undefined)).toBeUndefined();
    expect(audioMimeOf("audio/mp4")).toBeUndefined();
  });
});
