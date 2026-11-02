// Unit (без БД): загрузка файлов (T1-20) — заявка с проверкой типа и размера, PUT по подписанной ссылке local-драйвера,
// подтверждение по сигнатуре (не тот тип — rejected, объект удалён), ресайз inline в 3 варианта, приватный документ
// только по подписи. БД — media_assets в памяти по SQL; хранилище — local во временном каталоге.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { LocalStorageDriver, mediaKeys, type Storage } from "@tg/media";
import type { CompiledQuery } from "kysely";
import sharp from "sharp";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { TenancyModule } from "../../common/tenancy/index.js";
import { DATABASE, DatabaseModule } from "../../db/index.js";
import {
  PRINCIPAL_SOURCE,
  RbacModule,
  RbacTenantContextSource,
  RoleAssignmentsRepository,
  type Grant,
} from "../rbac/index.js";
import { LOCAL_PUT_RATE_LIMIT, LocalStorageController } from "./local-storage.controller.js";
import { MEDIA_JOBS, type InlineMediaJobs, type MediaJobs } from "./media.jobs.js";
import { MediaModule } from "./media.module.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const PLACE = "0190f5c2-7d3e-7000-8000-0000000000c1";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";
const ADMIN_A: Grant = {
  id: "0190f5c2-7d3e-7000-8000-0000000001aa",
  role: "TECH_REGION_ADMIN",
  scopeType: "REGION",
  scopeId: A,
  regionId: A,
  validUntil: null,
};
const AUDITOR_A: Grant = { ...ADMIN_A, role: "TECH_AUDITOR" };

type Row = Record<string, unknown>;

/** media_assets в памяти: insert/select/update так, как их компилирует MediaRepository. */
function fakeDb() {
  const rows = new Map<string, Row>();
  const columns = (sql: string, from: string, to: string) =>
    sql
      .slice(sql.indexOf(from) + from.length, sql.indexOf(to))
      .split(",")
      .map((c) => c.trim().replace(/^"|"$/g, ""));
  const { db } = recordingDb({}, (q: CompiledQuery) => {
    const p = q.parameters as unknown[];
    if (q.sql.startsWith('insert into "media_assets"')) {
      const cols = columns(q.sql, '"media_assets" (', ") values");
      const row: Row = {
        status: "pending",
        width: null,
        height: null,
        variants: {},
        reject_reason: null,
        uploaded_at: null,
        created_at: new Date("2026-11-02T10:00:00Z"),
        updated_at: new Date("2026-11-02T10:00:00Z"),
      };
      cols.forEach((c, i) => (row[c] = p[i]));
      rows.set(row.id as string, row);
      return [{ ...row }];
    }
    if (q.sql.startsWith('select * from "media_assets"')) {
      const row = rows.get(p[0] as string);
      return row && row.region_id === p[1] ? [{ ...row }] : [];
    }
    if (q.sql.startsWith('update "media_assets"')) {
      const sets = columns(q.sql, " set ", " where ").map((s) => s.split(" = ")[0]!.replace(/"/g, ""));
      const id = p[sets.length] as string;
      const statuses = p.slice(sets.length + 1, -1);
      const region = p[p.length - 1];
      const row = rows.get(id);
      if (!row || row.region_id !== region || !statuses.includes(row.status)) return [];
      sets.forEach((c, i) => (row[c] = p[i]));
      return [{ ...row }];
    }
    return [];
  });
  return { db, rows };
}

let dir: string;
let now: Date;
let app: INestApplication | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tg-media-api-"));
  now = new Date();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function start(opts: { grants?: Grant[]; jobs?: MediaJobs } = {}) {
  const fake = fakeDb();
  const storage: Storage = {
    driver: new LocalStorageDriver({
      dir,
      baseUrl: "http://api.test",
      secret: "x".repeat(40),
      now: () => now,
    }),
    publicBaseUrl: undefined,
    ephemeralSecret: false,
  };
  let builder = Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
      TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
      MediaModule.forRoot({ apiBaseUrl: "http://api.test", storageInstance: storage }),
    ],
  })
    .overrideProvider(DATABASE)
    .useValue(fake.db)
    .overrideProvider(PRINCIPAL_SOURCE)
    .useValue({ resolve: () => ({ userId: USER }) })
    .overrideProvider(RoleAssignmentsRepository)
    .useValue({ activeGrantsOf: () => Promise.resolve(opts.grants ?? [ADMIN_A]) });
  if (opts.jobs) builder = builder.overrideProvider(MEDIA_JOBS).useValue(opts.jobs);
  const moduleRef = await builder.compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "local" });
  await app.init();
  return { app, server: app.getHttpServer(), storage, ...fake };
}

/** Путь и query подписанной ссылки local (http://api.test/…) — для supertest. */
const pathOf = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

const jpeg = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: "#c87828" } })
    .jpeg()
    .withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "50/1 27/1 0/1" } })
    .toBuffer();

const upload = (server: unknown, body: Record<string, unknown>) =>
  request(server as never)
    .post("/media/uploads")
    .send({ ownerType: "place", ownerId: PLACE, kind: "image", ...body });

describe("POST /media/uploads: заявленный тип и размер", () => {
  it("jpeg до 10 МиБ — 201, pending и подписанная ссылка PUT", async () => {
    const { server, rows } = await start();
    const res = await upload(server, { mime: "image/jpeg", size: 1000, alt: { uk: "Фасад" } }).expect(201);
    expect(res.body.asset).toMatchObject({
      status: "pending",
      regionId: A,
      kind: "image",
      alt: { uk: "Фасад" },
    });
    expect(res.body.upload).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/jpeg" } });
    expect(res.body.upload.url).toMatch(/^http:\/\/api\.test\/storage\/objects\/private%2F/);
    expect(rows.get(res.body.asset.id)).toMatchObject({ created_by: USER, region_id: A });
  });

  it("gif, svg, pdf для фото, больше 10 МиБ — 422 с причиной; ничего не записано", async () => {
    const { server, rows } = await start();
    for (const mime of ["image/gif", "image/svg+xml", "application/pdf"]) {
      const res = await upload(server, { mime, size: 1000 }).expect(422);
      expect(res.body.error.details).toEqual({ reason: "mime_not_allowed" });
    }
    const big = await upload(server, { mime: "image/png", size: 10 * 1024 * 1024 + 1 }).expect(422);
    expect(big.body.error.details).toEqual({ reason: "size_too_large" });
    expect(rows.size).toBe(0);
  });

  it("без права media.upload в регионе — 403", async () => {
    const { server } = await start({ grants: [AUDITOR_A] });
    await upload(server, { mime: "image/jpeg", size: 1000 }).expect(403);
  });
});

/** Дождаться фоновых задач inline-ресайза. */
const settle = (a: INestApplication) => (a.get(MEDIA_JOBS) as InlineMediaJobs).idle();

async function put(server: unknown, url: string, mime: string, file: Buffer, status = 200) {
  await request(server as never)
    .put(pathOf(url))
    .set("Content-Type", mime)
    .send(file)
    .expect(status);
}

describe("загрузка → подтверждение → ресайз (inline, фоном после транзакции запроса)", () => {
  it("фото: uploaded, затем 3 варианта webp без EXIF; оригинал и загрузка удалены; ссылки по подписи", async () => {
    const { app, server, storage } = await start();
    const file = await jpeg(2000, 1000);
    const created = await upload(server, { mime: "image/jpeg", size: file.length }).expect(201);
    const id = created.body.asset.id as string;
    await put(server, created.body.upload.url, "image/jpeg", file);
    const confirmed = await request(server).post(`/media/${id}/confirm`).expect(200);
    expect(confirmed.body.status).toBe("uploaded");
    await settle(app);
    const res = await request(server).get(`/media/${id}`).expect(200);
    expect(res.body).toMatchObject({ status: "ready", width: 2000, height: 1000, rejectReason: null });
    expect(res.body.links.map((l: { name: string; width: number }) => [l.name, l.width])).toEqual([
      ["w320", 320],
      ["w800", 800],
      ["w1600", 1600],
    ]);
    expect(await storage.driver.size(mediaKeys.original(A, id))).toBeNull();
    expect(await storage.driver.size(mediaKeys.upload(A, id))).toBeNull();
    const variant = await request(server)
      .get(pathOf(res.body.links[0].url))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(variant.headers["content-type"]).toBe("image/webp");
    const meta = await sharp(variant.body as Buffer).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 320 });
    expect(meta.exif).toBeUndefined();
    // Повторное подтверждение — без изменений.
    expect((await request(server).post(`/media/${id}/confirm`).expect(200)).body.status).toBe("ready");
  });

  it("повторный PUT до подтверждения — 409; после — не подменяет проверенный файл", async () => {
    const { app, server } = await start();
    const file = await jpeg(400, 300);
    const created = await upload(server, { mime: "image/jpeg", size: file.length }).expect(201);
    const id = created.body.asset.id as string;
    await put(server, created.body.upload.url, "image/jpeg", file);
    const evil = Buffer.alloc(file.length, 0x3c);
    await put(server, created.body.upload.url, "image/jpeg", evil, 409);
    await request(server).post(`/media/${id}/confirm`).expect(200);
    // Ссылка ещё жива: PUT проходит в ключ загрузки, но обработка идёт по проверенной копии.
    await put(server, created.body.upload.url, "image/jpeg", evil);
    await settle(app);
    const res = await request(server).get(`/media/${id}`).expect(200);
    expect(res.body).toMatchObject({ status: "ready", width: 400, height: 300 });
  });

  it("файл недопустимого типа под видом jpeg — rejected type_mismatch, объекты удалены", async () => {
    const { server, storage } = await start();
    const file = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const created = await upload(server, { mime: "image/jpeg", size: file.length }).expect(201);
    const id = created.body.asset.id as string;
    await put(server, created.body.upload.url, "image/jpeg", file);
    const res = await request(server).post(`/media/${id}/confirm`).expect(200);
    expect(res.body).toMatchObject({ status: "rejected", rejectReason: "type_mismatch", links: [] });
    expect(await storage.driver.size(mediaKeys.upload(A, id))).toBeNull();
    expect(await storage.driver.size(mediaKeys.original(A, id))).toBeNull();
  });

  it("верная сигнатура, но не изображение — после обработки rejected decode_failed", async () => {
    const { app, server } = await start();
    const file = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
    const created = await upload(server, { mime: "image/jpeg", size: file.length }).expect(201);
    await put(server, created.body.upload.url, "image/jpeg", file);
    await request(server).post(`/media/${created.body.asset.id}/confirm`).expect(200);
    await settle(app);
    const res = await request(server).get(`/media/${created.body.asset.id}`).expect(200);
    expect(res.body).toMatchObject({ status: "rejected", rejectReason: "decode_failed" });
  });

  it("подтверждение без файла — 409 not_uploaded, статус pending", async () => {
    const { server, rows } = await start();
    const created = await upload(server, { mime: "image/png", size: 100 }).expect(201);
    const res = await request(server).post(`/media/${created.body.asset.id}/confirm`).expect(409);
    expect(res.body.error.details).toEqual({ reason: "not_uploaded" });
    expect(rows.get(created.body.asset.id)!.status).toBe("pending");
  });

  it("зависшая обработка (processing дольше 10 мин): повторное подтверждение обрабатывает заново", async () => {
    const { app, server, storage, rows } = await start();
    const created = await upload(server, { mime: "image/jpeg", size: 10 }).expect(201);
    const id = created.body.asset.id as string;
    await storage.driver.write(mediaKeys.original(A, id), await jpeg(400, 300), "image/jpeg");
    Object.assign(rows.get(id)!, {
      status: "processing",
      original_key: mediaKeys.original(A, id),
      updated_at: new Date(Date.now() - 60_000),
    });
    // Свежая обработка не трогается.
    expect((await request(server).post(`/media/${id}/confirm`).expect(200)).body.status).toBe("processing");
    rows.get(id)!.updated_at = new Date(Date.now() - 11 * 60_000);
    // Статус не сбрасывается: задача ставится заново, claim возьмёт и processing.
    expect((await request(server).post(`/media/${id}/confirm`).expect(200)).body.status).toBe("processing");
    await settle(app);
    expect((await request(server).get(`/media/${id}`).expect(200)).body.status).toBe("ready");
  });

  it("режим queue: после проверки — uploaded и задача ресайза; зависшая — новая задача (restart)", async () => {
    const queued: unknown[] = [];
    const { server, rows } = await start({ jobs: { enqueueProcessing: async (a) => void queued.push(a) } });
    const file = await jpeg(400, 300);
    const created = await upload(server, { mime: "image/jpeg", size: file.length }).expect(201);
    const id = created.body.asset.id as string;
    await put(server, created.body.upload.url, "image/jpeg", file);
    const res = await request(server).post(`/media/${id}/confirm`).expect(200);
    expect(res.body.status).toBe("uploaded");
    expect(queued).toEqual([{ id, regionId: A }]);
    rows.get(id)!.updated_at = new Date(Date.now() - 11 * 60_000);
    await request(server).post(`/media/${id}/confirm`).expect(200);
    expect(queued).toEqual([
      { id, regionId: A },
      { id, regionId: A, restart: true },
    ]);
  });

  it("неизвестный id — 404, некорректный — 400", async () => {
    const { server } = await start();
    await request(server).post(`/media/${PLACE}/confirm`).expect(404);
    await request(server).get("/media/x").expect(400);
  });
});

describe("PUT по ссылке local: подпись, тип и размер", () => {
  it("другой Content-Type — 400; больше подписанного размера — 413; без подписи — 403", async () => {
    const { server } = await start();
    const created = await upload(server, { mime: "image/png", size: 10 }).expect(201);
    const path = pathOf(created.body.upload.url);
    await request(server).put(path).set("Content-Type", "text/html").send(Buffer.alloc(10)).expect(400);
    await request(server).put(path).set("Content-Type", "image/png").send(Buffer.alloc(11)).expect(413);
    await request(server)
      .put(path.replace(/sig=[^&]+/, "sig=forged"))
      .set("Content-Type", "image/png")
      .send(Buffer.alloc(10))
      .expect(403);
  });
});

describe("маршруты local-драйвера и общие middleware api (T1-24)", () => {
  it("отдача — без rate limit, загрузка — свой лимит; CSP отдачи (sandbox) не перезаписан общей", async () => {
    const get = LocalStorageController.prototype.get;
    const putHandler = LocalStorageController.prototype.put;
    expect(Reflect.getMetadata("rateLimit:skip", get)).toBe(true);
    expect(Reflect.getMetadata("rateLimit:rule", putHandler)).toEqual(LOCAL_PUT_RATE_LIMIT);
    const { server, storage } = await start();
    await storage.driver.write("public/r/a/w320.webp", Buffer.from("RIFF0000WEBP"), "image/webp");
    const url = await storage.driver.presignGet("public/r/a/w320.webp", {
      contentType: "image/webp",
      expiresInSeconds: 60,
    });
    const res = await request(server).get(pathOf(url)).expect(200);
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    // Ответы JSON api — со своей CSP (security-headers middleware).
    const json = await request(server).get("/media/x").expect(400);
    expect(json.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(json.headers["content-security-policy"]).not.toContain("sandbox");
  });
});

describe("приватный документ: только по подписанной ссылке с коротким сроком", () => {
  it("ready сразу после проверки; без подписи, с поддельной или просроченной — 403", async () => {
    const { server } = await start();
    const file = Buffer.from("%PDF-1.7\n%test\n");
    const created = await upload(server, {
      kind: "private_document",
      mime: "application/pdf",
      size: file.length,
    }).expect(201);
    await request(server)
      .put(pathOf(created.body.upload.url))
      .set("Content-Type", "application/pdf")
      .send(file)
      .expect(200);
    const res = await request(server).post(`/media/${created.body.asset.id}/confirm`).expect(200);
    expect(res.body.status).toBe("ready");
    const [link] = res.body.links as { name: string; url: string; expiresAt: string }[];
    expect(link!.name).toBe("original");
    // Срок — 5 минут.
    expect(new Date(link!.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    const path = pathOf(link!.url);

    const ok = await request(server).get(path).expect(200);
    expect(ok.headers["content-disposition"]).toBe("attachment");
    expect(ok.headers["cache-control"]).toBe("private, no-store");

    const bare = path.slice(0, path.indexOf("?"));
    const noSig = await request(server).get(bare).expect(403);
    expect(noSig.body.error.details).toEqual({ reason: "malformed" });
    const forged = await request(server)
      .get(path.replace(/sig=[^&]+/, "sig=AAAA"))
      .expect(403);
    expect(forged.body.error.details).toEqual({ reason: "bad_signature" });

    now = new Date(now.getTime() + 5 * 60_000 + 1000);
    const expired = await request(server).get(path).expect(403);
    expect(expired.body.error.details).toEqual({ reason: "expired" });
  });
});
