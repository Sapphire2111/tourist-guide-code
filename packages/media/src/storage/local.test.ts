import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LocalObjectExistsError,
  LocalStorageDriver,
  LocalUploadSizeError,
  publishNoOverwrite,
  signLocal,
  verifyLocal,
} from "./local.js";
import { isValidStorageKey } from "./types.js";

const SECRET = "x".repeat(40);
const NOW = new Date("2026-11-02T10:00:00Z");
const KEY = "private/r1/a1/original";

let dir: string;
let storage: LocalStorageDriver;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tg-media-"));
  storage = new LocalStorageDriver({ dir, baseUrl: "https://api.test/", secret: SECRET, now: () => NOW });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Ключ и query из подписанной ссылки local. */
function parse(url: string) {
  const u = new URL(url);
  const key = decodeURIComponent(u.pathname.replace(/^\/storage\/objects\//, ""));
  return { key, query: Object.fromEntries(u.searchParams) as Record<string, string> };
}

describe("подпись ссылок local-драйвера (HMAC)", () => {
  it("ссылка на чтение проходит проверку до истечения срока", async () => {
    const url = await storage.presignGet(KEY, { contentType: "application/pdf", expiresInSeconds: 300 });
    expect(url.startsWith("https://api.test/storage/objects/private%2Fr1%2Fa1%2Foriginal?")).toBe(true);
    const { key, query } = parse(url);
    const r = verifyLocal("get", key, query, SECRET, NOW);
    expect(r).toMatchObject({ ok: true, params: { key: KEY, ct: "application/pdf", dl: 0 } });
  });

  it("просроченная подпись — expired", async () => {
    const { key, query } = parse(
      await storage.presignGet(KEY, { contentType: "image/webp", expiresInSeconds: 300 }),
    );
    const later = new Date(NOW.getTime() + 301_000);
    expect(verifyLocal("get", key, query, SECRET, later)).toEqual({ ok: false, reason: "expired" });
  });

  it("без подписи — malformed; подмена ключа, срока, типа, операции или секрета — bad_signature", async () => {
    const { key, query } = parse(
      await storage.presignGet(KEY, { contentType: "image/webp", expiresInSeconds: 300 }),
    );
    const { sig: _sig, ...unsigned } = query;
    expect(verifyLocal("get", key, unsigned, SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyLocal("get", "private/r1/a2/original", query, SECRET, NOW).ok).toBe(false);
    expect(verifyLocal("get", key, { ...query, exp: String(Number(query.exp) + 3600) }, SECRET, NOW)).toEqual(
      {
        ok: false,
        reason: "bad_signature",
      },
    );
    expect(verifyLocal("get", key, { ...query, ct: "text/html" }, SECRET, NOW).ok).toBe(false);
    expect(verifyLocal("put", key, query, SECRET, NOW).ok).toBe(false);
    expect(verifyLocal("get", key, query, "y".repeat(40), NOW).ok).toBe(false);
  });

  it("ссылка на загрузку подписывает тип и точный размер", async () => {
    const up = await storage.presignPut(KEY, {
      contentType: "image/png",
      contentLength: 42,
      expiresInSeconds: 900,
    });
    expect(up.method).toBe("PUT");
    expect(up.headers).toEqual({ "Content-Type": "image/png" });
    expect(up.expiresAt.toISOString()).toBe("2026-11-02T10:15:00.000Z");
    const { key, query } = parse(up.url);
    expect(verifyLocal("put", key, query, SECRET, NOW)).toMatchObject({ ok: true, params: { len: 42 } });
    expect(verifyLocal("put", key, { ...query, len: "43" }, SECRET, NOW).ok).toBe(false);
  });

  it("подпись детерминирована и зависит от всех полей", () => {
    const p = { op: "get", key: KEY, exp: 1, ct: "image/webp", len: 0, dl: 0 } as const;
    expect(signLocal(p, SECRET)).toBe(signLocal({ ...p }, SECRET));
    expect(signLocal(p, SECRET)).not.toBe(signLocal({ ...p, dl: 1 }, SECRET));
  });
});

describe("файлы local-драйвера", () => {
  it("запись, размер, первые байты, чтение, удаление (повторное — без ошибки)", async () => {
    await storage.write(KEY, Buffer.from("hello world"));
    expect(await storage.size(KEY)).toBe(11);
    expect(Buffer.from((await storage.readHead(KEY, 5))!).toString()).toBe("hello");
    expect((await storage.read(KEY))!.toString()).toBe("hello world");
    await storage.delete(KEY);
    await storage.delete(KEY);
    expect(await storage.size(KEY)).toBeNull();
    expect(await storage.readHead(KEY, 5)).toBeNull();
    expect(await storage.read(KEY)).toBeNull();
  });

  it("приём потока: ровно подписанный размер; больше или меньше — LocalUploadSizeError, файла и мусора нет", async () => {
    await storage.writeStream(KEY, Readable.from([Buffer.from("abc"), Buffer.from("de")]), 5);
    expect(await storage.size(KEY)).toBe(5);
    const other = "private/r1/a2/original";
    await expect(
      storage.writeStream(other, Readable.from([Buffer.from("abcdef")]), 5),
    ).rejects.toBeInstanceOf(LocalUploadSizeError);
    await expect(storage.writeStream(other, Readable.from([Buffer.from("abc")]), 5)).rejects.toBeInstanceOf(
      LocalUploadSizeError,
    );
    expect(await storage.size(other)).toBeNull();
    expect(await readdir(join(dir, "private", "r1", "a2"))).toEqual([]);
  });

  it("повторный PUT в уже загруженный ключ — LocalObjectExistsError, содержимое прежнее", async () => {
    await storage.writeStream(KEY, Readable.from([Buffer.from("first")]), 5);
    await expect(storage.writeStream(KEY, Readable.from([Buffer.from("other")]), 5)).rejects.toBeInstanceOf(
      LocalObjectExistsError,
    );
    expect((await storage.read(KEY))!.toString()).toBe("first");
  });

  it("ФС без жёстких ссылок (EPERM/ENOTSUP/EXDEV) — копия без перезаписи; цель есть — EEXIST", async () => {
    const tmp = join(dir, "t.tmp");
    const dest = join(dir, "dest");
    await writeFile(tmp, "data");
    for (const code of ["EPERM", "ENOTSUP", "EXDEV"]) {
      await rm(dest, { force: true });
      const noLink = async () => {
        throw Object.assign(new Error(code), { code });
      };
      await publishNoOverwrite(tmp, dest, noLink);
      expect(await readFile(dest, "utf8")).toBe("data");
      await expect(publishNoOverwrite(tmp, dest, noLink)).rejects.toMatchObject({ code: "EEXIST" });
    }
    const otherError = async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    await expect(publishNoOverwrite(tmp, join(dir, "x"), otherError)).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("copy: серверная копия; нет источника — false", async () => {
    await storage.write(KEY, Buffer.from("abc"));
    expect(await storage.copy(KEY, "private/r1/a1/copy")).toBe(true);
    expect((await storage.read("private/r1/a1/copy"))!.toString()).toBe("abc");
    expect(await storage.copy("private/r1/none/x", "private/r1/none/y")).toBe(false);
  });

  it("ключ с «..», абсолютный, с обратным слэшем — отказ", () => {
    for (const bad of ["../etc/passwd", "private/../../x", "/abs", "a\\b", "a//b", "", "a/./b"]) {
      expect(isValidStorageKey(bad)).toBe(false);
      expect(() => storage.path(bad)).toThrow();
    }
    expect(isValidStorageKey("public/r1/a1/w320.webp")).toBe(true);
  });
});
