// Подписи s3-драйвера без сети: presigner считает SigV4 локально. Живое хранилище (R2/MinIO) здесь не проверяется.
import { describe, expect, it } from "vitest";
import { createStorage } from "./factory.js";
import { S3StorageDriver } from "./s3.js";

const NOW = new Date("2026-11-02T10:00:00Z");
const storage = new S3StorageDriver({
  bucket: "tg-test",
  endpoint: "https://acc.r2.cloudflarestorage.com",
  region: "auto",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "secret",
  now: () => NOW,
});

describe("S3StorageDriver: подписанные ссылки", () => {
  it("PUT: тип и размер в подписи, срок — в ссылке; path-style при endpoint", async () => {
    const up = await storage.presignPut("private/r1/a1/original", {
      contentType: "image/jpeg",
      contentLength: 1234,
      expiresInSeconds: 900,
    });
    const u = new URL(up.url);
    expect(u.host).toBe("acc.r2.cloudflarestorage.com");
    expect(u.pathname).toBe("/tg-test/private/r1/a1/original");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(u.searchParams.get("X-Amz-Date")).toBe("20261102T100000Z");
    expect(up.headers).toEqual({ "Content-Type": "image/jpeg" });
    expect(up.expiresAt.toISOString()).toBe("2026-11-02T10:15:00.000Z");
  });

  it("GET: короткий срок и тип ответа; документ — attachment", async () => {
    const url = new URL(
      await storage.presignGet("private/r1/a1/original", {
        contentType: "application/pdf",
        expiresInSeconds: 300,
        download: true,
      }),
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("response-content-type")).toBe("application/pdf");
    expect(url.searchParams.get("response-content-disposition")).toBe("attachment");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("недопустимый ключ — ошибка до подписи", async () => {
    await expect(
      storage.presignGet("../x", { contentType: "image/webp", expiresInSeconds: 60 }),
    ).rejects.toThrow();
  });
});

describe("createStorage", () => {
  it("s3 без ключей — ошибка; local без секрета — временный секрет", () => {
    expect(() => createStorage({ STORAGE_DRIVER: "s3", S3_BUCKET: "b" }, "http://api")).toThrow(
      /S3_ACCESS_KEY_ID/,
    );
    const local = createStorage({ STORAGE_DRIVER: "local" }, "http://api");
    expect(local.driver.driver).toBe("local");
    expect(local.ephemeralSecret).toBe(true);
    const fixed = createStorage(
      {
        STORAGE_DRIVER: "local",
        STORAGE_SIGNING_SECRET: "x".repeat(32),
        STORAGE_PUBLIC_BASE_URL: "https://cdn/",
      },
      "http://api",
    );
    expect(fixed).toMatchObject({ ephemeralSecret: false, publicBaseUrl: "https://cdn" });
  });
});
