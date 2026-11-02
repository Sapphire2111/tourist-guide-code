import { createHash } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ApiError } from "../../common/http/index.js";
import {
  InjectDb,
  regionContext,
  withTenant,
  type Db,
  type EmergencyContact,
  type LonLat,
  type PlaceEnrichment,
  type PromotionAdLabel,
  type Region,
} from "../../db/index.js";
import { toScheduleDto } from "../catalog/index.js";
import { EmergencyContactsRepository } from "../emergency-contacts/index.js";
import { MediaService } from "../media/index.js";
import { RegionsRepository } from "../regions/index.js";
import type {
  CoverPhotoDto,
  FavoriteDto,
  FavoriteListDto,
  GuideCategoryListDto,
  PlaceCardDto,
  PlacePhotoDto,
  PlaceSearchResultDto,
  PlaceSummaryDto,
} from "./guide.dto.js";
import { SEARCH_OFFSET_MAX } from "./guide.dto.js";
import { GooglePhotosService, type GooglePhotoWidth } from "./google-photos.js";
import { FAVORITES_MAX, GuideRepository, type PhotoRow, type PlaceRow } from "./guide.repository.js";
import { localMoment, openState, type LocalMoment, type ScheduleRows } from "./open-now.js";

/**
 * Описание — автоописание импорта Google («Ресторан у Яремчі. Джерело: Google Maps.», places-import/mapping.ts
 * describe): у места из импорта текст оканчивается подписью источника. Ручное описание (админка, партнёр) — нет.
 */
export function isAutoDescription(source: string | undefined, d: { uk: string } | null): boolean {
  return source === "google" && Boolean(d && /Джерело: Google Maps\.\s*$/.test(d.uk));
}

/** Версия обложки (ETag и параметр v ссылки): меняется вместе с файлом. */
export function coverEtag(photoName: string, fetchedAt: Date): string {
  return createHash("sha256").update(`${photoName}|${fetchedAt.toISOString()}`).digest("hex").slice(0, 16);
}

export type SearchParams = {
  origin?: LonLat;
  /** Радиус, м — только с origin. */
  radius?: number;
  categoryId?: string;
  text?: string;
  limit: number;
  offset: number;
};

/**
 * Публичный каталог туриста (блок 4, ADR-0019). Регион — из запроса (данные публичные): должен существовать и быть
 * active, иначе 404; чтение — в withTenant(regionContext) этого региона (RLS + TenantGuardPlugin). Туристу видны
 * только опубликованные места в активной категории. «Відкрито зараз» — по графику в таймзоне региона на момент
 * запроса (`now` — для тестов).
 */
@Injectable()
export class GuideService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(GuideRepository) private readonly repo: GuideRepository,
    @Inject(RegionsRepository) private readonly regions: RegionsRepository,
    @Inject(EmergencyContactsRepository) private readonly contacts: EmergencyContactsRepository,
    @Inject(MediaService) private readonly media: MediaService,
    // Необязателен: без него (тесты, сборка без GuideModule) фото Google в карточке не показываются.
    @Optional() @Inject(GooglePhotosService) private readonly googlePhotos?: GooglePhotosService,
  ) {}

  /** Часы сервиса (подменяется в тестах). */
  now: () => Date = () => new Date();

  async categories(regionId: string): Promise<GuideCategoryListDto> {
    return this.inRegion(regionId, async () => {
      const rows = await this.repo.activeCategories();
      const own = await this.repo.publishedCountByCategory();
      const total = new Map<string, number>();
      for (const c of rows) {
        const n = own.get(c.id) ?? 0;
        total.set(c.id, (total.get(c.id) ?? 0) + n);
        if (c.parent_id) total.set(c.parent_id, (total.get(c.parent_id) ?? 0) + n);
      }
      return {
        items: rows.map((c) => ({
          id: c.id,
          parentId: c.parent_id,
          code: c.code,
          name: c.name_i18n,
          icon: c.icon,
          homeSection: c.home_section,
          sortOrder: c.sort_order,
          placeCount: total.get(c.id) ?? 0,
        })),
      };
    });
  }

  async search(regionId: string, params: SearchParams): Promise<PlaceSearchResultDto> {
    return this.inRegion(regionId, async (region) => {
      const rows = await this.repo.search(params);
      const page = rows.slice(0, params.limit);
      return {
        items: await this.summaries(region, page),
        // Дальше SEARCH_OFFSET_MAX листать нельзя (валидация offset) — следующей страницы для клиента нет.
        nextOffset:
          rows.length > params.limit && params.offset + params.limit <= SEARCH_OFFSET_MAX
            ? params.offset + params.limit
            : null,
        radiusMeters: params.origin ? (params.radius ?? null) : null,
      };
    });
  }

  async place(
    regionId: string,
    id: string,
    opts: { origin?: LonLat; userId?: string },
  ): Promise<PlaceCardDto | undefined> {
    // До транзакции региона: учёт запросов Google — на корневом соединении. Предел исчерпан — галерея Google не
    // отдаётся, остаётся обложка у нас.
    const exhausted = this.googlePhotos ? await this.googlePhotos.exhausted() : true;
    return this.inRegion(regionId, async (region) => {
      const row = await this.repo.findPublished(id, opts.origin);
      if (!row) return undefined;
      const at = localMoment(this.now(), region.timezone);
      const [category, tags, photos, schedules, labels, favorite, enrichment] = await Promise.all([
        this.repo.findCategory(row.category_id),
        this.repo.placeTags(id),
        this.repo.photos([id]),
        this.repo.schedules([id], { from: at.previousDate }),
        this.repo.adLabels([id]),
        opts.userId ? this.repo.isFavorite(opts.userId, id) : Promise.resolve(null),
        this.repo.enrichment(id),
      ]);
      const schedule = schedules.get(id) ?? { weekly: [], exceptions: [] };
      const state = openState(schedule, at);
      const photoDtos = await Promise.all(photos.map((p) => this.photo(p)));
      const external = await this.coverPhotos(region.id, [id]);
      return {
        ...this.summary(
          row,
          labels.get(id) ?? null,
          state.openNow,
          photoDtos[0] ?? null,
          external.get(id) ?? null,
        ),
        regionId: row.region_id,
        category: {
          id: row.category_id,
          parentId: category?.parent_id ?? null,
          name: category?.name_i18n ?? row.name_i18n,
          icon: category?.icon ?? null,
        },
        description: row.description_i18n,
        descriptionAuto: isAutoDescription(row.source, row.description_i18n),
        website: row.website,
        telegram: row.telegram,
        verifiedAt: row.verified_at?.toISOString() ?? null,
        photos: photoDtos,
        tags: tags.map((t) => ({ id: t.id, code: t.code, name: t.name_i18n, group: t.tag_group })),
        schedule: toScheduleDto({
          timezone: region.timezone,
          weekly: schedule.weekly.map((w) => ({
            dayOfWeek: w.dayOfWeek,
            opensAt: w.opensAt.slice(0, 5),
            closesAt: w.closesAt.slice(0, 5),
          })),
          exceptions: schedule.exceptions.map((e) => ({
            date: e.date,
            closed: e.closed,
            opensAt: e.opensAt?.slice(0, 5) ?? null,
            closesAt: e.closesAt?.slice(0, 5) ?? null,
            note: e.note,
          })),
        }),
        openUntil: state.openUntil,
        favorite,
        ...this.enriched(region.id, id, enrichment, exhausted),
      };
    });
  }

  /**
   * Адрес файла фото Google для прокси: n-е фото обогащения опубликованного места региона. undefined — места, фото
   * или адреса нет (404).
   */
  async googlePhoto(
    regionId: string,
    id: string,
    index: number,
    width: GooglePhotoWidth,
  ): Promise<string | undefined> {
    const name = await this.inRegion(regionId, async () => {
      if (!(await this.repo.findPublished(id, undefined))) return undefined;
      return (await this.repo.enrichment(id))?.google?.photos[index]?.name;
    });
    if (!name || !this.googlePhotos) return undefined;
    // Вне транзакции региона: запрос к Google не держит соединение с БД открытым.
    return (await this.googlePhotos.uri(name, width)) ?? undefined;
  }

  /** Поля богатой карточки из обогащения; нет данных — пустые (блоки карточка не покажет). */
  private enriched(
    regionId: string,
    placeId: string,
    e:
      | Pick<PlaceEnrichment, "google" | "wiki" | "ai_summary_uk" | "ai_model" | "ai_generated_at">
      | undefined,
    photosExhausted = false,
  ): Pick<
    PlaceCardDto,
    | "typeLabel"
    | "summary"
    | "aiSummary"
    | "priceLevel"
    | "amenities"
    | "rating"
    | "reviews"
    | "googlePhotos"
    | "googleMapsUri"
    | "wikipedia"
  > {
    const g = e?.google ?? null;
    const w = e?.wiki ?? null;
    return {
      typeLabel: g?.typeLabel ?? null,
      summary: g?.summary ?? null,
      aiSummary:
        e?.ai_summary_uk && e.ai_model && e.ai_generated_at
          ? { text: e.ai_summary_uk, model: e.ai_model, generatedAt: e.ai_generated_at.toISOString() }
          : null,
      priceLevel: g?.priceLevel ?? null,
      amenities: g?.amenities ?? [],
      rating:
        g?.rating !== null && g?.rating !== undefined && g.ratingCount
          ? { value: g.rating, count: g.ratingCount, source: "google" }
          : null,
      reviews: g?.reviews ?? [],
      googlePhotos:
        this.googlePhotos?.enabled && !photosExhausted
          ? (g?.photos ?? []).map((p, i) => ({
              url: this.googlePhotos!.proxyUrl(regionId, placeId, i, 400, p.name),
              largeUrl: this.googlePhotos!.proxyUrl(regionId, placeId, i, 1200, p.name),
              width: p.width,
              height: p.height,
              authors: p.authors,
            }))
          : [],
      googleMapsUri: g?.mapsUri ?? null,
      wikipedia: w ? { ...w, truncated: w.truncated ?? false } : null,
    };
  }

  async favorites(regionId: string, userId: string): Promise<FavoriteListDto> {
    return this.inRegion(regionId, async (region) => ({
      items: await this.summaries(region, await this.repo.favorites(userId)),
    }));
  }

  /** undefined — места нет в регионе или оно не опубликовано. */
  async addFavorite(regionId: string, userId: string, placeId: string): Promise<FavoriteDto | undefined> {
    return this.inRegion(regionId, async () => {
      if (!(await this.repo.findPublished(placeId, undefined))) return undefined;
      // Лимит списка (его выдача — до FAVORITES_MAX): новое место сверх лимита — 409; повтор уже добавленного — нет.
      if (
        !(await this.repo.isFavorite(userId, placeId)) &&
        (await this.repo.countFavorites(userId)) >= FAVORITES_MAX
      )
        throw new ApiError("CONFLICT", {
          messageKey: "errors.favorites.limitReached",
          details: { reason: "favorites_limit", limit: FAVORITES_MAX },
        });
      const row = await this.repo.addFavorite(userId, placeId);
      return { placeId: row.place_id, createdAt: row.created_at.toISOString() };
    });
  }

  /** Убрать можно и снятое с публикации место (оно уже не видно в списке, но запись осталась). */
  async removeFavorite(regionId: string, userId: string, placeId: string): Promise<void> {
    await this.inRegion(regionId, () => this.repo.removeFavorite(userId, placeId));
  }

  async emergencyContacts(regionId: string): Promise<EmergencyContact[]> {
    return this.inRegion(regionId, () => this.contacts.list({ active: true }));
  }

  /** Активный регион или 404; fn — в транзакции с контекстом региона. */
  private async inRegion<T>(regionId: string, fn: (region: Region) => Promise<T>): Promise<T> {
    const region = await this.regions.findById(regionId.toLowerCase());
    if (region?.status !== "active") throw new ApiError("NOT_FOUND");
    return withTenant(this.db, regionContext(region.id), () => fn(region));
  }

  /** Строки выдачи → DTO: обложка, метка рекламы, «Відкрито зараз» — пачкой на страницу. */
  private async summaries(region: Region, rows: readonly PlaceRow[]): Promise<PlaceSummaryDto[]> {
    const ids = rows.map((r) => r.id);
    const at: LocalMoment = localMoment(this.now(), region.timezone);
    const [covers, labels, schedules, external] = await Promise.all([
      this.repo.covers(ids),
      this.repo.adLabels(ids),
      this.repo.schedules(ids, { in: [at.previousDate, at.date] }),
      this.coverPhotos(region.id, ids),
    ]);
    const coverOf = new Map<string, PlacePhotoDto>();
    await Promise.all(covers.map(async (c) => coverOf.set(c.place_id, await this.photo(c))));
    return rows.map((r) => {
      const s: ScheduleRows = schedules.get(r.id) ?? { weekly: [], exceptions: [] };
      return this.summary(
        r,
        labels.get(r.id) ?? null,
        openState(s, at).openNow,
        coverOf.get(r.id) ?? null,
        external.get(r.id) ?? null,
      );
    });
  }

  private summary(
    r: PlaceRow,
    adLabel: PromotionAdLabel | null,
    openNow: boolean | null,
    cover: PlacePhotoDto | null,
    coverPhoto: CoverPhotoDto | null,
  ): PlaceSummaryDto {
    return {
      id: r.id,
      categoryId: r.category_id,
      name: r.name_i18n,
      address: r.address_i18n,
      // Выборка берёт только места с точкой (опубликованное место без точки не сохраняется — CHECK 0012).
      location: r.location ?? { lon: 0, lat: 0 },
      // Дециметры: точность расстояния PostGIS не теряется на коротких дистанциях.
      distanceMeters: r.distance === null ? null : Math.round(Number(r.distance) * 10) / 10,
      recommended: r.recommended,
      adLabel,
      openNow,
      phone: r.phone,
      cover,
      coverPhoto,
    };
  }

  /** Обложки у нас (0018) по местам: ссылка на GET /places/{id}/cover с версией (ETag) и подписью автора. */
  private async coverPhotos(regionId: string, ids: readonly string[]): Promise<Map<string, CoverPhotoDto>> {
    const rows = await this.repo.coverMeta(ids);
    return new Map(
      rows.map((c) => [
        c.place_id,
        {
          url: this.coverUrl(regionId, c.place_id, coverEtag(c.photo_name, c.fetched_at)),
          width: c.width,
          height: c.height,
          source: c.source,
          authors: c.author_attributions,
          license: c.license,
          sourceUrl: c.source_url,
        },
      ]),
    );
  }

  private coverUrl(regionId: string, placeId: string, etag: string): string {
    const base = this.googlePhotos?.apiBaseUrl ?? "";
    return `${base}/places/${placeId}/cover?regionId=${regionId}&v=${etag}`;
  }

  /**
   * Обложка места для GET /places/{id}/cover; undefined — места или обложки нет. notModified(etag) — у клиента та же
   * версия (If-None-Match): байты из БД не читаются, bytes — null.
   */
  async cover(
    regionId: string,
    id: string,
    notModified: (etag: string) => boolean = () => false,
  ): Promise<{ bytes: Buffer | null; mime: string; etag: string } | undefined> {
    return this.inRegion(regionId, async () => {
      if (!(await this.repo.findPublished(id, undefined))) return undefined;
      const v = await this.repo.coverVersion(id);
      if (!v) return undefined;
      const etag = coverEtag(v.photo_name, v.fetched_at);
      if (notModified(etag)) return { bytes: null, mime: v.mime, etag };
      const c = await this.repo.coverBytes(id);
      // Обложку заменили между запросами — версия по прочитанной строке.
      return c ? { bytes: c.bytes, mime: c.mime, etag: coverEtag(c.photo_name, c.fetched_at) } : undefined;
    });
  }

  private async photo(p: PhotoRow): Promise<PlacePhotoDto> {
    const links = await this.media.links(p);
    return {
      mediaAssetId: p.id,
      alt: p.alt_i18n,
      width: p.width,
      height: p.height,
      isCover: p.is_cover,
      variants: links.map((l) => ({ ...l, expiresAt: l.expiresAt?.toISOString() ?? null })),
    };
  }
}
