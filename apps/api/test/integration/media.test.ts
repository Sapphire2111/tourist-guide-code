// T1-20: файлы и изображения на реальной PostgreSQL (миграция 0009) под ролью приложения: RLS по региону,
// CHECK типов и статусов, функции worker media_asset_* (claim/complete/reject — идемпотентно, от имени SYSTEM),
// полный цикл MediaService (local-хранилище, ресайз inline) в транзакции региона.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageDriver, mediaKeys, type Storage } from "@tg/media";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabase, regionContext, withTenant, type Db } from "../../src/db/index.js";
import { InlineMediaJobs, MediaRepository, MediaService } from "../../src/modules/media/index.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

// Учётка только тестового контейнера.
const APP_LOGIN = "tg_api_media_test";
const APP_PASSWORD = "tg_api_media_test";
const OWNER = "0190f5c2-7d3e-7000-8000-0000000000c1";

describe.skipIf(!dockerAvailable)(`Файлы и изображения (T1-20)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let appDb: Db;
  let appClient: pg.Client;
  let regionA: string;
  let regionB: string;
  let dir: string;
  let storage: Storage;

  beforeAll(async () => {
    tdb = await startDatabase();
    const owner = tdb.client;
    await owner.query(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    const region = async (code: string) =>
      String(
        (
          await owner.query(
            `INSERT INTO regions (code, name_i18n) VALUES ($1, '{"uk": "Регіон"}') RETURNING id`,
            [code],
          )
        ).rows[0]!.id,
      );
    regionA = await region("t120-a");
    regionB = await region("t120-b");
    const url = new URL(tdb.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    appDb = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
    appClient = new pg.Client({ connectionString: url.toString() });
    await appClient.connect();
    dir = await mkdtemp(join(tmpdir(), "tg-media-it-"));
    storage = {
      driver: new LocalStorageDriver({ dir, baseUrl: "http://api.test", secret: "s".repeat(32) }),
      publicBaseUrl: undefined,
      ephemeralSecret: false,
    };
  }, 180_000);

  afterAll(async () => {
    await appClient?.end();
    await appDb?.destroy();
    await stopDatabase(tdb);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const insert = (regionId: string, extra: Record<string, unknown> = {}) =>
    withTenant(appDb, regionContext(regionId), () =>
      new MediaRepository(appDb).create({
        region_id: regionId,
        owner_type: "place",
        owner_id: OWNER,
        kind: "image",
        mime: "image/jpeg",
        size_bytes: 100,
        original_key: "private/x/y/original",
        ...extra,
      } as never),
    );

  it("миграция 0009 применена", () => {
    expect(tdb!.applied).toContain("0009_media_assets.sql");
  });

  it("RLS: файл региона A не виден в контексте B", async () => {
    const a = await insert(regionA);
    const seen = await withTenant(appDb, regionContext(regionB), () => new MediaRepository(appDb).find(a.id));
    expect(seen).toBeUndefined();
    const own = await withTenant(appDb, regionContext(regionA), () => new MediaRepository(appDb).find(a.id));
    expect(own?.id).toBe(a.id);
  });

  it("CHECK: pdf только у документа, неизвестный тип, лимит размера, alt с uk", async () => {
    await expect(insert(regionA, { mime: "application/pdf" })).rejects.toMatchObject({
      constraint: "media_assets_pdf_only_document",
    });
    await expect(insert(regionA, { mime: "image/gif" })).rejects.toMatchObject({
      constraint: "media_assets_mime_check",
    });
    await expect(insert(regionA, { size_bytes: 10 * 1024 * 1024 + 1 })).rejects.toMatchObject({
      constraint: "media_assets_size_check",
    });
    await expect(insert(regionA, { alt_i18n: { en: "x" } })).rejects.toMatchObject({
      constraint: "media_assets_alt_i18n_check",
    });
    await expect(
      insert(regionA, { kind: "private_document", mime: "application/pdf" }),
    ).resolves.toBeDefined();
  });

  it("функции worker: pending не берётся, uploaded → processing → ready; повтор — no-op", async () => {
    const a = await insert(regionA);
    const claim = async () =>
      (await appClient.query("SELECT * FROM media_asset_claim_processing($1)", [a.id])).rows[0] as
        | Record<string, unknown>
        | undefined;
    expect(await claim()).toMatchObject({ status: "pending", region_id: regionA });
    // Подтверждение (api) — владельцем-суперпользователем контейнера, мимо RLS.
    await tdb!.client.query("UPDATE media_assets SET status = 'uploaded' WHERE id = $1", [a.id]);
    expect(await claim()).toMatchObject({ status: "processing", kind: "image", mime: "image/jpeg" });
    expect(await claim()).toMatchObject({ status: "processing" });
    const complete = () =>
      appClient.query("SELECT media_asset_complete_processing($1, 10, 20, $2::jsonb) AS done", [
        a.id,
        JSON.stringify({ w320: { key: "public/k", width: 10, height: 20, bytes: 1 } }),
      ]);
    expect((await complete()).rows[0]!.done).toBe(true);
    expect((await complete()).rows[0]!.done).toBe(false);
    expect(
      (await appClient.query("SELECT media_asset_reject($1, 'decode_failed') AS done", [a.id])).rows[0]!.done,
    ).toBe(false);
    expect(await claim()).toMatchObject({ status: "ready" });
    // app.actor восстановлен: без контекста строки не видны.
    expect((await appClient.query("SELECT count(*)::int AS n FROM media_assets")).rows[0]!.n).toBe(0);
  });

  it("MediaService: заявка → файл → подтверждение → 3 варианта (inline, после транзакции); не тот тип — rejected", async () => {
    const jobs = new InlineMediaJobs(appDb, storage);
    const service = new MediaService(new MediaRepository(appDb), storage, jobs);
    const inA = <T>(fn: () => Promise<T>) => withTenant(appDb, regionContext(regionA), fn);
    const file = await sharp({ create: { width: 1000, height: 500, channels: 3, background: "#123456" } })
      .png()
      .toBuffer();
    const { asset } = await inA(() =>
      service.createUpload({
        regionId: regionA,
        ownerType: "place",
        ownerId: OWNER,
        kind: "image",
        mime: "image/png",
        size: file.length,
        alt: { uk: "Фото" },
        createdBy: null,
      }),
    );
    expect(asset.original_key).toBe(mediaKeys.upload(regionA, asset.id));
    await storage.driver.write(asset.original_key, file, "image/png");
    const uploaded = await inA(() => service.confirm(asset.id));
    expect(uploaded).toMatchObject({
      status: "uploaded",
      original_key: mediaKeys.original(regionA, asset.id),
    });
    await jobs.idle();
    const ready = await inA(() => service.find(asset.id));
    expect(ready).toMatchObject({ status: "ready", width: 1000, height: 500 });
    expect(await storage.driver.size(mediaKeys.original(regionA, asset.id))).toBeNull();
    expect(Object.keys(ready!.variants)).toEqual(["w320", "w800", "w1600"]);

    const { asset: bad } = await inA(() =>
      service.createUpload({
        regionId: regionA,
        ownerType: "place",
        ownerId: OWNER,
        kind: "image",
        mime: "image/png",
        size: 5,
        alt: null,
        createdBy: null,
      }),
    );
    await storage.driver.write(bad.original_key, Buffer.from("GIF89"), "image/png");
    expect(await inA(() => service.confirm(bad.id))).toMatchObject({
      status: "rejected",
      reject_reason: "type_mismatch",
    });
    expect(await storage.driver.size(bad.original_key)).toBeNull();
    expect(await storage.driver.size(mediaKeys.original(regionA, bad.id))).toBeNull();
  });
});
