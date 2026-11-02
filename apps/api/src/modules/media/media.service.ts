import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  checkUploadedObject,
  MAGIC_BYTES_LENGTH,
  mediaKeys,
  PRIVATE_URL_TTL_SECONDS,
  PUBLIC_URL_TTL_SECONDS,
  STALE_PROCESSING_MS,
  UPLOAD_URL_TTL_SECONDS,
  uuidv7,
  validateUploadRequest,
  type MediaKind,
  type MediaOwnerType,
  type PresignedUpload,
  type Storage,
  type UploadRejectReason,
} from "@tg/media";
import type { LocalizedText, MediaAsset } from "../../db/index.js";
import { MEDIA_JOBS, type MediaJobs } from "./media.jobs.js";
import { MediaRepository } from "./media.repository.js";

export const MEDIA_STORAGE = Symbol("MEDIA_STORAGE");

export type MediaErrorReason = UploadRejectReason | "owner_region_mismatch" | "not_uploaded";

/** Отказ по правилам медиа; контроллер превращает его в ответ API (код — по причине). */
export class MediaError extends Error {
  override readonly name = "MediaError";
  constructor(readonly reason: MediaErrorReason) {
    super(`Медиа: ${reason}`);
  }
}

export interface CreateUploadInput {
  regionId: string;
  ownerType: MediaOwnerType;
  ownerId: string;
  kind: MediaKind;
  mime: string;
  size: number;
  alt: LocalizedText | null;
  createdBy: string | null;
}

/** Ссылка на вариант или документ. */
export interface MediaLink {
  name: string;
  url: string;
  width: number | null;
  height: number | null;
  /** Срок подписанной ссылки; null — постоянный публичный адрес (STORAGE_PUBLIC_BASE_URL). */
  expiresAt: Date | null;
}

/**
 * Загрузка файлов по подписанным ссылкам (T1-20, ADR-0013): заявка (тип и размер) → PUT клиента прямо в
 * хранилище → подтверждение (копия загрузки в проверенный ключ, размер и сигнатура копии; не то — rejected и
 * удаление) → ресайз фото (очередь или inline, после транзакции запроса) → выдача ссылок. Вызывается в транзакции
 * запроса (withTenant): регион — из контекста.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger("Media");

  constructor(
    @Inject(MediaRepository) private readonly repo: MediaRepository,
    @Inject(MEDIA_STORAGE) private readonly storage: Storage,
    @Inject(MEDIA_JOBS) private readonly jobs: MediaJobs,
  ) {}

  async createUpload(input: CreateUploadInput): Promise<{ asset: MediaAsset; upload: PresignedUpload }> {
    const check = validateUploadRequest(input);
    if (!check.ok) throw new MediaError(check.reason);
    if (input.ownerType === "region" && input.ownerId.toLowerCase() !== input.regionId.toLowerCase())
      throw new MediaError("owner_region_mismatch");
    const id = uuidv7();
    // До подтверждения original_key — ключ загрузки; подтверждение заменит его проверенной копией.
    const uploadKey = mediaKeys.upload(input.regionId, id);
    const asset = await this.repo.create({
      id,
      region_id: input.regionId,
      owner_type: input.ownerType,
      owner_id: input.ownerId,
      kind: input.kind,
      mime: check.mime,
      size_bytes: input.size,
      original_key: uploadKey,
      alt_i18n: input.alt,
      created_by: input.createdBy,
    });
    const upload = await this.storage.driver.presignPut(uploadKey, {
      contentType: check.mime,
      contentLength: input.size,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });
    return { asset, upload };
  }

  /**
   * Подтверждение загрузки. Сначала серверная копия загруженного объекта в проверенный ключ (original): проверка
   * размера и сигнатуры идёт по копии, и повторный PUT по ещё живой ссылке её уже не подменит (иначе можно было бы
   * загрузить другой файл после проверки). Отклонение — не ошибка запроса, а статус rejected в ответе (иначе откат
   * транзакции вернул бы pending). Повтор безопасен: не pending — текущее состояние; uploaded/processing без
   * изменений дольше STALE_PROCESSING_MS — обработка зависла (сбой worker/процесса), ставится заново.
   */
  async confirm(id: string): Promise<MediaAsset | undefined> {
    const asset = await this.repo.find(id, { lock: true });
    if (!asset) return asset;
    if (asset.status === "uploaded" || asset.status === "processing") return this.restartIfStale(asset);
    if (asset.status !== "pending") return asset;
    const driver = this.storage.driver;
    const uploadKey = asset.original_key;
    const originalKey = mediaKeys.original(asset.region_id, asset.id);
    // Нет загрузки, но копия уже есть — прошлое подтверждение скопировало и откатилось: проверяем копию.
    if (!(await driver.copy(uploadKey, originalKey)) && (await driver.size(originalKey)) === null)
      throw new MediaError("not_uploaded");
    const size = await driver.size(originalKey);
    const head = size === null ? null : await driver.readHead(originalKey, MAGIC_BYTES_LENGTH);
    const check = checkUploadedObject(
      { mime: asset.mime, size: asset.size_bytes },
      size === null || head === null ? null : { size, head },
    );
    await driver.delete(uploadKey);
    if (!check.ok) {
      await driver.delete(originalKey);
      if (check.reason === "not_uploaded") throw new MediaError("not_uploaded");
      this.logger.warn(`Файл ${id} отклонён: ${check.reason}`);
      return this.repo.update(id, ["pending"], { status: "rejected", reject_reason: check.reason });
    }
    const now = new Date();
    if (asset.kind === "private_document")
      return this.repo.update(id, ["pending"], {
        status: "ready",
        uploaded_at: now,
        original_key: originalKey,
      });
    const uploaded = await this.repo.update(id, ["pending"], {
      status: "uploaded",
      uploaded_at: now,
      original_key: originalKey,
    });
    if (uploaded) await this.jobs.enqueueProcessing({ id, regionId: asset.region_id });
    return uploaded;
  }

  /**
   * Зависшая обработка — заново (новая задача / новый проход inline). Статус не меняется (claim берёт и processing),
   * только отсчёт срока начинается заново (updated_at — триггером), чтобы следующий confirm не ставил задачу снова.
   */
  private async restartIfStale(asset: MediaAsset): Promise<MediaAsset | undefined> {
    if (Date.now() - asset.updated_at.getTime() < STALE_PROCESSING_MS) return asset;
    this.logger.warn(`Обработка файла ${asset.id} зависла (${asset.status}) — перезапуск`);
    const restarted = await this.repo.update(asset.id, [asset.status], { status: asset.status });
    if (restarted)
      await this.jobs.enqueueProcessing({ id: asset.id, regionId: asset.region_id, restart: true });
    return restarted;
  }

  find(id: string): Promise<MediaAsset | undefined> {
    return this.repo.find(id);
  }

  /**
   * Ссылки готового файла. Фото — варианты: публичный адрес (STORAGE_PUBLIC_BASE_URL) или подписанная ссылка на
   * час. Документ — только подписанная ссылка на 5 минут, как вложение. Не ready — пусто.
   */
  async links(asset: MediaAsset): Promise<MediaLink[]> {
    if (asset.status !== "ready") return [];
    const driver = this.storage.driver;
    if (asset.kind === "private_document") {
      return [
        {
          name: "original",
          url: await driver.presignGet(asset.original_key, {
            contentType: asset.mime,
            expiresInSeconds: PRIVATE_URL_TTL_SECONDS,
            download: true,
          }),
          width: null,
          height: null,
          expiresAt: new Date(Date.now() + PRIVATE_URL_TTL_SECONDS * 1000),
        },
      ];
    }
    const base = this.storage.publicBaseUrl;
    return Promise.all(
      Object.entries(asset.variants).map(async ([name, v]) => ({
        name,
        url: base
          ? `${base}/${v.key}`
          : await driver.presignGet(v.key, {
              contentType: "image/webp",
              expiresInSeconds: PUBLIC_URL_TTL_SECONDS,
            }),
        width: v.width,
        height: v.height,
        expiresAt: base ? null : new Date(Date.now() + PUBLIC_URL_TTL_SECONDS * 1000),
      })),
    );
  }
}
