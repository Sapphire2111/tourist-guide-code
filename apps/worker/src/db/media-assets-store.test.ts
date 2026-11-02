// Unit (без БД): задача media.process-image (T1-20) — ресайз в 3 варианта, идемпотентность по статусу, отклонение
// не-изображения, ретрай pending. Состояние — в памяти; хранилище — local во временном каталоге. Функции БД
// media_asset_* на реальной PostgreSQL — apps/api/test/integration/media.test.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnrecoverableError } from "bullmq";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalStorageDriver, mediaKeys, type StoredVariants } from "@tg/media";
import { systemContext } from "@tg/queue-contract";
import { createHandlers, type ClaimedMediaAsset, type MediaAssetStore } from "../queue/handlers.js";
import { mediaAssetStore } from "./media-assets-store.js";

const R = "0190f5c2-7d3e-7000-8000-00000000000a";
const ID = "0190f5c2-7d3e-7000-8000-0000000000f1";
const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx = { context: systemContext(R), jobId: "j1", attempt: 1, logger };

/** Одна строка media_assets в памяти с переходами, как у функций БД из миграции 0009. */
function memoryStore(status: string) {
  const row = {
    status,
    kind: "image",
    regionId: R,
    originalKey: mediaKeys.original(R, ID),
    mime: "image/jpeg",
  };
  let variants: StoredVariants | undefined;
  const store: MediaAssetStore = {
    claim: async (id) => {
      if (id !== ID) return null;
      if (row.status === "uploaded" || row.status === "processing") row.status = "processing";
      return { ...row } satisfies ClaimedMediaAsset;
    },
    complete: async (_id, _w, _h, v) => {
      if (row.status !== "processing") return false;
      row.status = "ready";
      variants = v;
      return true;
    },
    reject: async () => {
      if (row.status === "ready" || row.status === "rejected") return false;
      row.status = "rejected";
      return true;
    },
  };
  return { store, row, variants: () => variants };
}

let dir: string;
let storage: LocalStorageDriver;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tg-worker-media-"));
  storage = new LocalStorageDriver({ dir, baseUrl: "http://x", secret: "s".repeat(32) });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const photo = () =>
  sharp({ create: { width: 1800, height: 1200, channels: 3, background: "#336699" } })
    .jpeg()
    .withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "50/1 27/1 0/1" } })
    .toBuffer();

describe("задача media.process-image", () => {
  it("uploaded → ready: 3 варианта webp, оригинал удалён; повтор — без эффекта", async () => {
    const m = memoryStore("uploaded");
    await storage.write(m.row.originalKey, await photo());
    const handler = createHandlers({ media: { assets: m.store, storage } })["media.process-image"];
    const res = await handler({ assetId: ID }, ctx);
    expect(res).toEqual({ assetId: ID, status: "ready", variants: ["w320", "w800", "w1600"] });
    expect(m.row.status).toBe("ready");
    expect(Object.values(m.variants()!).map((v) => [v.width, v.height])).toEqual([
      [320, 213],
      [800, 534],
      [1600, 1067],
    ]);
    for (const v of Object.values(m.variants()!)) {
      const meta = await sharp((await storage.read(v.key))!).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.exif).toBeUndefined();
    }
    expect(await storage.size(m.row.originalKey)).toBeNull();
    await expect(handler({ assetId: ID }, ctx)).resolves.toEqual({
      assetId: ID,
      status: "ready",
      repeated: true,
    });
  });

  it("pending (подтверждение ещё не закоммичено) — обычная ошибка для ретрая", async () => {
    const m = memoryStore("pending");
    const handler = createHandlers({ media: { assets: m.store, storage } })["media.process-image"];
    const err = await handler({ assetId: ID }, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it("гонка: отметка не применилась (строку уже отметила новая задача) — оригинал не удаляется", async () => {
    const m = memoryStore("uploaded");
    await storage.write(m.row.originalKey, await photo());
    const assets = { ...m.store, complete: async () => false, reject: async () => false };
    const handler = createHandlers({ media: { assets, storage } })["media.process-image"];
    await handler({ assetId: ID }, ctx);
    expect(await storage.size(m.row.originalKey)).not.toBeNull();
    await storage.write(
      m.row.originalKey,
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)]),
    );
    m.row.status = "processing";
    await expect(handler({ assetId: ID }, ctx)).resolves.toMatchObject({ status: "rejected" });
    expect(await storage.size(m.row.originalKey)).not.toBeNull();
  });

  it("не изображение — rejected, оригинал удалён, без ретраев", async () => {
    const m = memoryStore("uploaded");
    await storage.write(
      m.row.originalKey,
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)]),
    );
    const handler = createHandlers({ media: { assets: m.store, storage } })["media.process-image"];
    await expect(handler({ assetId: ID }, ctx)).resolves.toEqual({ assetId: ID, status: "rejected" });
    expect(m.row.status).toBe("rejected");
    expect(await storage.size(m.row.originalKey)).toBeNull();
  });

  it("SVG за заявленным jpeg (sharp его декодирует) — rejected type_mismatch", async () => {
    const m = memoryStore("uploaded");
    const reasons: string[] = [];
    const store = {
      ...m.store,
      reject: async (id: string, reason: string) => (
        reasons.push(reason),
        m.store.reject(id, reason as never)
      ),
    };
    await storage.write(
      m.row.originalKey,
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
    );
    const handler = createHandlers({ media: { assets: store, storage } })["media.process-image"];
    await expect(handler({ assetId: ID }, ctx)).resolves.toEqual({ assetId: ID, status: "rejected" });
    expect(reasons).toEqual(["type_mismatch"]);
  });

  it("чужой регион контекста, неизвестный id, некорректный id, нет зависимостей — UnrecoverableError", async () => {
    const m = memoryStore("uploaded");
    const handler = createHandlers({ media: { assets: m.store, storage } })["media.process-image"];
    await expect(handler({ assetId: ID }, { ...ctx, context: systemContext(null) })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(handler({ assetId: "0190f5c2-7d3e-7000-8000-000000000000" }, ctx)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(handler({ assetId: "x" }, ctx)).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(createHandlers()["media.process-image"]({ assetId: ID }, ctx)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});

describe("mediaAssetStore: вызовы функций БД", () => {
  it("claim, complete (варианты — jsonb-строкой), reject", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ status: "processing", kind: "image", region_id: R, original_key: "k", mime: "image/png" }],
      })
      .mockResolvedValueOnce({ rows: [{ done: true }] })
      .mockResolvedValueOnce({ rows: [{ done: false }] })
      .mockResolvedValueOnce({ rows: [] });
    const store = mediaAssetStore({ query });
    await expect(store.claim(ID)).resolves.toEqual({
      status: "processing",
      kind: "image",
      regionId: R,
      originalKey: "k",
      mime: "image/png",
    });
    await expect(store.complete(ID, 10, 20, {})).resolves.toBe(true);
    expect(query.mock.calls[1]).toEqual([
      "SELECT media_asset_complete_processing($1::uuid, $2::integer, $3::integer, $4::jsonb) AS done",
      [ID, 10, 20, "{}"],
    ]);
    await expect(store.reject(ID, "decode_failed")).resolves.toBe(false);
    await expect(store.claim(ID)).resolves.toBeNull();
  });
});
