// Драйвер s3: любое S3-совместимое хранилище (Cloudflare R2, Backblaze B2, MinIO, S3Mock в local).
// Подписи — SigV4 через @aws-sdk/s3-request-presigner; бакет приватный, публичный доступ — только к префиксу
// public/ через STORAGE_PUBLIC_BASE_URL (настраивается у провайдера, ADR-0013).
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  assertValidStorageKey,
  type PresignedUpload,
  type PresignGetOptions,
  type PresignPutOptions,
  type StorageDriver,
} from "./types.js";

export interface S3StorageOptions {
  bucket: string;
  /** Адрес S3 API; не задан — AWS S3 по региону. Для R2/B2/MinIO обязателен. */
  endpoint?: string;
  /** Регион подписи; R2 — "auto". */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style адресация (MinIO, S3Mock); по умолчанию — при заданном endpoint. */
  forcePathStyle?: boolean;
  now?: () => Date;
}

const isNotFound = (e: unknown) =>
  e instanceof S3ServiceException
    ? e.$metadata.httpStatusCode === 404 || e.name === "NotFound" || e.name === "NoSuchKey"
    : false;

export class S3StorageDriver implements StorageDriver {
  readonly driver = "s3" as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly now: () => Date;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.now = options.now ?? (() => new Date());
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // Контрольные суммы по умолчанию (SDK ≥ 3.729) часть S3-совместимых хранилищ не поддерживает; в подписанный
      // PUT браузера они тоже не попадут — только когда операция требует.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async presignPut(key: string, o: PresignPutOptions): Promise<PresignedUpload> {
    assertValidStorageKey(key);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: o.contentType,
      ContentLength: o.contentLength,
    });
    // Content-Type и Content-Length входят в подпись: другой тип или размер хранилище отклонит (403).
    const url = await getSignedUrl(this.client, command, {
      expiresIn: o.expiresInSeconds,
      signableHeaders: new Set(["content-type", "content-length"]),
      signingDate: this.now(),
    });
    return {
      url,
      method: "PUT",
      headers: { "Content-Type": o.contentType },
      expiresAt: new Date(this.now().getTime() + o.expiresInSeconds * 1000),
    };
  }

  async presignGet(key: string, o: PresignGetOptions): Promise<string> {
    assertValidStorageKey(key);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentType: o.contentType,
      ...(o.download ? { ResponseContentDisposition: "attachment" } : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: o.expiresInSeconds, signingDate: this.now() });
  }

  async size(key: string): Promise<number | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return head.ContentLength ?? 0;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async readHead(key: string, length: number): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${length - 1}` }),
      );
      const bytes = (await res.Body?.transformToByteArray()) ?? new Uint8Array();
      return bytes.subarray(0, length);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from((await res.Body?.transformToByteArray()) ?? new Uint8Array());
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async write(key: string, body: Buffer, contentType: string): Promise<void> {
    assertValidStorageKey(key);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async copy(fromKey: string, toKey: string): Promise<boolean> {
    assertValidStorageKey(fromKey);
    assertValidStorageKey(toKey);
    try {
      await this.client.send(
        new CopyObjectCommand({ Bucket: this.bucket, Key: toKey, CopySource: `${this.bucket}/${fromKey}` }),
      );
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    // DeleteObject идемпотентен: отсутствующий ключ — 204.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
