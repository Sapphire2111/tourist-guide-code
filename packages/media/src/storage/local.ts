// Драйвер local: объекты — файлы в каталоге, подписанные ссылки — HMAC-SHA256 на маршруты самого api
// (GET/PUT /storage/objects/:key, контроллер в apps/api). Для local, тестов и staging без ключей S3.
// Каталог должен быть общим у api и worker (на Render free он эфемерен — ADR-0013).
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { copyFile, link, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assertValidStorageKey,
  type PresignedUpload,
  type PresignGetOptions,
  type PresignPutOptions,
  type StorageDriver,
} from "./types.js";

/** Коды, при которых ФС не умеет жёсткие ссылки (FAT/exFAT, часть сетевых и overlay ФС, разные устройства). */
const NO_HARDLINK = new Set(["EPERM", "ENOTSUP", "EXDEV", "EOPNOTSUPP", "ENOSYS"]);

/**
 * Опубликовать временный файл под путём без перезаписи: жёсткая ссылка (атомарно, EEXIST при наличии), а где ФС их
 * не поддерживает — копия с COPYFILE_EXCL (тоже EEXIST при наличии; не атомарна, но цель не перезаписывается).
 */
export async function publishNoOverwrite(
  tmp: string,
  dest: string,
  linkFn: (from: string, to: string) => Promise<void> = link,
): Promise<void> {
  try {
    await linkFn(tmp, dest);
  } catch (e) {
    if (!NO_HARDLINK.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
    await copyFile(tmp, dest, fsConstants.COPYFILE_EXCL);
  }
}

/** Путь маршрутов api, которые обслуживают ссылки local-драйвера. */
export const LOCAL_STORAGE_ROUTE = "storage/objects";

/** Параметры подписанной ссылки local (query). */
export interface LocalSignedParams {
  op: "put" | "get";
  key: string;
  /** Срок, unix-время в секундах. */
  exp: number;
  /** Content-Type: put — обязателен в запросе; get — отдаётся в ответе. */
  ct: string;
  /** put: точный размер тела, байт; get: 0. */
  len: number;
  /** get: 1 — Content-Disposition: attachment. */
  dl: 0 | 1;
}

function canonical(p: LocalSignedParams): string {
  return ["tg-storage-v1", p.op, p.key, p.exp, p.ct, p.len, p.dl].join("\n");
}

export function signLocal(params: LocalSignedParams, secret: string): string {
  return createHmac("sha256", secret).update(canonical(params)).digest("base64url");
}

export type LocalVerifyResult =
  | { ok: true; params: LocalSignedParams }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Проверка подписи ссылки из запроса. Сначала подпись (постоянное время сравнения), потом срок: просроченная
 * ссылка с верной подписью — expired, подделка — bad_signature.
 */
export function verifyLocal(
  op: "put" | "get",
  key: string,
  query: Record<string, unknown>,
  secret: string,
  now: Date = new Date(),
): LocalVerifyResult {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const exp = Number(str(query.exp));
  const len = Number(str(query.len) ?? "0");
  const ct = str(query.ct);
  const dl = str(query.dl) === "1" ? 1 : 0;
  const sig = str(query.sig);
  if (!Number.isSafeInteger(exp) || !Number.isSafeInteger(len) || len < 0 || !ct || !sig)
    return { ok: false, reason: "malformed" };
  const params: LocalSignedParams = { op, key, exp, ct, len, dl };
  const expected = Buffer.from(signLocal(params, secret));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return { ok: false, reason: "bad_signature" };
  if (exp * 1000 <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, params };
}

/** Объект по ссылке на загрузку уже загружен: повторный PUT не перезаписывает его (409). */
export class LocalObjectExistsError extends Error {
  override readonly name = "LocalObjectExistsError";
}

/** Загруженное тело не совпало с подписанным размером. */
export class LocalUploadSizeError extends Error {
  override readonly name = "LocalUploadSizeError";
}

export interface LocalStorageOptions {
  /** Каталог объектов (создаётся при первой записи). */
  dir: string;
  /** Внешний адрес api, на который ведут ссылки (PUBLIC_API_URL), без завершающего «/». */
  baseUrl: string;
  /** Секрет HMAC (STORAGE_SIGNING_SECRET). */
  secret: string;
  /** Часы (тесты). */
  now?: () => Date;
}

export class LocalStorageDriver implements StorageDriver {
  readonly driver = "local" as const;
  private readonly root: string;
  private readonly baseUrl: string;
  private readonly now: () => Date;

  constructor(private readonly options: LocalStorageOptions) {
    this.root = resolve(options.dir);
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.now = options.now ?? (() => new Date());
  }

  /** Путь файла объекта внутри корня (ключ проверен; выход за корень невозможен). */
  path(key: string): string {
    assertValidStorageKey(key);
    const p = resolve(this.root, ...key.split("/"));
    if (!p.startsWith(this.root + sep)) throw new Error("Ключ вне каталога хранилища");
    return p;
  }

  private url(params: LocalSignedParams): string {
    const q = new URLSearchParams({
      exp: String(params.exp),
      ct: params.ct,
      ...(params.op === "put" ? { len: String(params.len) } : {}),
      ...(params.dl ? { dl: "1" } : {}),
      sig: signLocal(params, this.options.secret),
    });
    return `${this.baseUrl}/${LOCAL_STORAGE_ROUTE}/${encodeURIComponent(params.key)}?${q.toString()}`;
  }

  private expiry(seconds: number): number {
    return Math.floor(this.now().getTime() / 1000) + seconds;
  }

  /** Проверка подписанной ссылки из запроса (секретом этого драйвера, по его часам). */
  verify(op: "put" | "get", key: string, query: Record<string, unknown>): LocalVerifyResult {
    return verifyLocal(op, key, query, this.options.secret, this.now());
  }

  async presignPut(key: string, o: PresignPutOptions): Promise<PresignedUpload> {
    assertValidStorageKey(key);
    const exp = this.expiry(o.expiresInSeconds);
    return {
      url: this.url({ op: "put", key, exp, ct: o.contentType, len: o.contentLength, dl: 0 }),
      method: "PUT",
      headers: { "Content-Type": o.contentType },
      expiresAt: new Date(exp * 1000),
    };
  }

  async presignGet(key: string, o: PresignGetOptions): Promise<string> {
    assertValidStorageKey(key);
    return this.url({
      op: "get",
      key,
      exp: this.expiry(o.expiresInSeconds),
      ct: o.contentType,
      len: 0,
      dl: o.download ? 1 : 0,
    });
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.path(key))).size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async readHead(key: string, length: number): Promise<Uint8Array | null> {
    let fh;
    try {
      fh = await open(this.path(key), "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  /** Content-Type не хранится: local отдаёт тип из подписанной ссылки. */
  async write(key: string, body: Buffer, _contentType?: string): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, p);
  }

  /**
   * Приём тела PUT по подписанной ссылке: пишет во временный файл и публикует его под ключом, только если размер ровно
   * `length` (больше — обрыв на лету, без записи лишнего на диск). Иначе LocalUploadSizeError, файла нет. Объект уже
   * есть — LocalObjectExistsError без перезаписи (жёсткая ссылка не заменяет существующий файл — без гонки).
   */
  async writeStream(key: string, body: Readable, length: number): Promise<void> {
    const p = this.path(key);
    if ((await this.size(key)) !== null) throw new LocalObjectExistsError("Объект уже загружен");
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    let received = 0;
    try {
      await pipeline(
        body,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            received += chunk.length;
            if (received > length) throw new LocalUploadSizeError("Тело больше подписанного размера");
            yield chunk;
          }
        },
        createWriteStream(tmp),
      );
      if (received !== length) throw new LocalUploadSizeError("Тело меньше подписанного размера");
      try {
        await publishNoOverwrite(tmp, p);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST")
          throw new LocalObjectExistsError("Объект уже загружен");
        throw e;
      }
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async copy(fromKey: string, toKey: string): Promise<boolean> {
    const to = this.path(toKey);
    await mkdir(dirname(to), { recursive: true });
    const tmp = `${to}.${randomUUID()}.tmp`;
    try {
      await copyFile(this.path(fromKey), tmp);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
    await rename(tmp, to);
    return true;
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
