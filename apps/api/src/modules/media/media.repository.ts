import { Injectable } from "@nestjs/common";
import {
  currentDb,
  InjectDb,
  type Db,
  type MediaAsset,
  type MediaAssetUpdate,
  type NewMediaAsset,
} from "../../db/index.js";

/**
 * media_assets (tenant, миграция 0009) без правил: что и когда можно — MediaService. Запросы — через currentDb():
 * внутри withTenant() — транзакция запроса, TenantGuardPlugin добавляет фильтр region_id, RLS — второй рубеж.
 */
@Injectable()
export class MediaRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  create(values: NewMediaAsset): Promise<MediaAsset> {
    return currentDb(this.db)
      .insertInto("media_assets")
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Файл по id (только своего региона — фильтр tenant); lock — блокировка строки до конца транзакции. */
  find(id: string, opts: { lock?: boolean } = {}): Promise<MediaAsset | undefined> {
    const q = currentDb(this.db).selectFrom("media_assets").selectAll().where("id", "=", id);
    return (opts.lock ? q.forUpdate() : q).executeTakeFirst();
  }

  /**
   * Взять фото в обработку: uploaded/processing → processing (как функция БД media_asset_claim_processing для worker).
   * Взять нельзя — текущее состояние строки; нет строки — undefined.
   */
  async claim(id: string): Promise<MediaAsset | undefined> {
    return (
      (await this.update(id, ["uploaded", "processing"], { status: "processing" })) ?? (await this.find(id))
    );
  }

  /** Изменить строку; `fromStatus` — только если статус ещё прежний (переходы без гонок). */
  update(
    id: string,
    fromStatus: readonly string[],
    patch: MediaAssetUpdate,
  ): Promise<MediaAsset | undefined> {
    return currentDb(this.db)
      .updateTable("media_assets")
      .set(patch)
      .where("id", "=", id)
      .where("status", "in", [...fromStatus])
      .returningAll()
      .executeTakeFirst();
  }
}
