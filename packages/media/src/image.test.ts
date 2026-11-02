import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mediaKeys } from "./constants.js";
import { ImageRejectError, processImage, renderVariants } from "./image.js";
import { LocalStorageDriver } from "./storage/local.js";

/** Тестовая картинка, сгенерированная sharp: однотонная, с EXIF (в т.ч. GPS — геоданные съёмки). */
function makeJpeg(width: number, height: number, orientation?: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } })
    .jpeg()
    .withExif({
      IFD0: { Copyright: "test", Artist: "Тест" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "50/1 27/1 0/1" },
    })
    .withMetadata(orientation ? { orientation } : {})
    .toBuffer();
}

describe("renderVariants: ресайз", () => {
  it("3 варианта webp по ширине 320/800/1600 с сохранением пропорций", async () => {
    const r = await renderVariants(await makeJpeg(2000, 1000), { expectedMime: "image/jpeg" });
    expect(r).toMatchObject({ width: 2000, height: 1000 });
    expect(r.variants.map((v) => [v.name, v.width, v.height])).toEqual([
      ["w320", 320, 160],
      ["w800", 800, 400],
      ["w1600", 1600, 800],
    ]);
    for (const v of r.variants) {
      const m = await sharp(v.data).metadata();
      expect(m.format).toBe("webp");
      expect(v.bytes).toBe(v.data.length);
    }
  });

  it("маленькая картинка не увеличивается: всё равно 3 варианта, ширина не больше исходной", async () => {
    const r = await renderVariants(await makeJpeg(500, 250), { expectedMime: "image/jpeg" });
    expect(r.variants.map((v) => [v.name, v.width, v.height])).toEqual([
      ["w320", 320, 160],
      ["w800", 500, 250],
      ["w1600", 500, 250],
    ]);
  });

  it("EXIF (включая GPS) удаляется из вариантов", async () => {
    const source = await makeJpeg(400, 300);
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const r = await renderVariants(source, { expectedMime: "image/jpeg" });
    for (const v of r.variants) {
      const m = await sharp(v.data).metadata();
      expect(m.exif).toBeUndefined();
      expect(m.xmp).toBeUndefined();
      expect(m.iptc).toBeUndefined();
    }
  });

  it("ориентация из EXIF применяется: снимок «на боку» становится вертикальным", async () => {
    const r = await renderVariants(await makeJpeg(400, 200, 6), { expectedMime: "image/jpeg" });
    expect(r).toMatchObject({ width: 200, height: 400 });
    expect(r.variants[0]).toMatchObject({ width: 200, height: 400 });
  });

  it("png и webp тоже принимаются", async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: "#fff0" } })
      .png()
      .toBuffer();
    expect((await renderVariants(png, { expectedMime: "image/png" })).variants).toHaveLength(3);
    const webp = await sharp(png).webp().toBuffer();
    expect((await renderVariants(webp, { expectedMime: "image/webp" })).variants).toHaveLength(3);
  });

  it("SVG, GIF, TIFF (декодируются sharp) — type_mismatch; png под видом jpeg — type_mismatch", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#000" } })
      .gif()
      .toBuffer();
    const tiff = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#000" } })
      .tiff()
      .toBuffer();
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#000" } })
      .png()
      .toBuffer();
    for (const [buf, mime] of [
      [svg, "image/jpeg"],
      [gif, "image/png"],
      [tiff, "image/webp"],
      [png, "image/jpeg"],
      [png, "image/svg+xml"],
    ] as const) {
      await expect(renderVariants(buf, { expectedMime: mime })).rejects.toMatchObject({
        reason: "type_mismatch",
      });
    }
  });

  it("больше предела пикселей — dimensions_too_large", async () => {
    await expect(
      renderVariants(await makeJpeg(400, 300), { expectedMime: "image/jpeg", maxPixels: 100_000 }),
    ).rejects.toMatchObject({ reason: "dimensions_too_large" });
  });

  it("не изображение за верной сигнатурой — ImageRejectError", async () => {
    const fake = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from("<script>alert(1)</script>"),
    ]);
    await expect(renderVariants(fake, { expectedMime: "image/jpeg" })).rejects.toBeInstanceOf(
      ImageRejectError,
    );
  });
});

describe("processImage: оригинал из хранилища → варианты в public/", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tg-media-img-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("пишет 3 варианта по детерминированным ключам; повтор — те же ключи", async () => {
    const storage = new LocalStorageDriver({ dir, baseUrl: "http://x", secret: "s".repeat(32) });
    const asset = {
      id: "a1",
      regionId: "r1",
      originalKey: mediaKeys.original("r1", "a1"),
      mime: "image/jpeg",
    };
    await storage.write(asset.originalKey, await makeJpeg(1000, 500), "image/jpeg");
    const first = await processImage(storage, asset);
    expect(Object.keys(first.variants)).toEqual(["w320", "w800", "w1600"]);
    expect(first.variants.w320!.key).toBe("public/r1/a1/w320.webp");
    expect(first.variants.w1600).toMatchObject({ width: 1000, height: 500 });
    for (const v of Object.values(first.variants)) expect(await storage.size(v.key)).toBe(v.bytes);
    const again = await processImage(storage, asset);
    expect(again.variants).toEqual(first.variants);
  });

  it("нет оригинала — original_missing", async () => {
    const storage = new LocalStorageDriver({ dir, baseUrl: "http://x", secret: "s".repeat(32) });
    await expect(
      processImage(storage, {
        id: "a9",
        regionId: "r1",
        originalKey: mediaKeys.original("r1", "a9"),
        mime: "image/jpeg",
      }),
    ).rejects.toMatchObject({ reason: "original_missing" });
  });
});
