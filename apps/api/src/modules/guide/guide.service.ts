import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../../common/http/index.js";
import {
  InjectDb,
  regionContext,
  withTenant,
  type Db,
  type EmergencyContact,
  type LonLat,
  type PromotionAdLabel,
  type Region,
} from "../../db/index.js";
import { toScheduleDto } from "../catalog/index.js";
import { EmergencyContactsRepository } from "../emergency-contacts/index.js";
import { MediaService } from "../media/index.js";
import { RegionsRepository } from "../regions/index.js";
import type {
  FavoriteDto,
  FavoriteListDto,
  GuideCategoryListDto,
  PlaceCardDto,
  PlacePhotoDto,
  PlaceSearchResultDto,
  PlaceSummaryDto,
} from "./guide.dto.js";
import { GuideRepository, type PhotoRow, type PlaceRow } from "./guide.repository.js";
import { localMoment, openState, type LocalMoment, type ScheduleRows } from "./open-now.js";

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
        nextOffset: rows.length > params.limit ? params.offset + params.limit : null,
        radiusMeters: params.origin ? (params.radius ?? null) : null,
      };
    });
  }

  async place(
    regionId: string,
    id: string,
    opts: { origin?: LonLat; userId?: string },
  ): Promise<PlaceCardDto | undefined> {
    return this.inRegion(regionId, async (region) => {
      const row = await this.repo.findPublished(id, opts.origin);
      if (!row) return undefined;
      const at = localMoment(this.now(), region.timezone);
      const [category, tags, photos, schedules, labels, favorite] = await Promise.all([
        this.repo.findCategory(row.category_id),
        this.repo.placeTags(id),
        this.repo.photos([id]),
        this.repo.schedules([id], { from: at.previousDate }),
        this.repo.adLabels([id]),
        opts.userId ? this.repo.isFavorite(opts.userId, id) : Promise.resolve(null),
      ]);
      const schedule = schedules.get(id) ?? { weekly: [], exceptions: [] };
      const state = openState(schedule, at);
      const photoDtos = await Promise.all(photos.map((p) => this.photo(p)));
      return {
        ...this.summary(row, labels.get(id) ?? null, state.openNow, photoDtos[0] ?? null),
        regionId: row.region_id,
        category: {
          id: row.category_id,
          parentId: category?.parent_id ?? null,
          name: category?.name_i18n ?? row.name_i18n,
          icon: category?.icon ?? null,
        },
        description: row.description_i18n,
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
      };
    });
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
    const [covers, labels, schedules] = await Promise.all([
      this.repo.covers(ids),
      this.repo.adLabels(ids),
      this.repo.schedules(ids, { in: [at.previousDate, at.date] }),
    ]);
    const coverOf = new Map<string, PlacePhotoDto>();
    await Promise.all(covers.map(async (c) => coverOf.set(c.place_id, await this.photo(c))));
    return rows.map((r) => {
      const s: ScheduleRows = schedules.get(r.id) ?? { weekly: [], exceptions: [] };
      return this.summary(r, labels.get(r.id) ?? null, openState(s, at).openNow, coverOf.get(r.id) ?? null);
    });
  }

  private summary(
    r: PlaceRow,
    adLabel: PromotionAdLabel | null,
    openNow: boolean | null,
    cover: PlacePhotoDto | null,
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
    };
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
