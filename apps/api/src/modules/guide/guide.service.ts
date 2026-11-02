import { Injectable } from "@nestjs/common";
import { ApiError } from "../../common/http/index.js";
import type { EmergencyContact, LonLat } from "../../db/index.js";
import type {
  FavoriteDto,
  FavoriteListDto,
  GuideCategoryListDto,
  PlaceCardDto,
  PlaceSearchResultDto,
} from "./guide.dto.js";

export type SearchParams = {
  origin?: LonLat;
  /** Радиус, м — только с origin. */
  radius?: number;
  categoryId?: string;
  text?: string;
  limit: number;
  offset: number;
};

const notImplemented = (): never => {
  throw new ApiError("SERVICE_UNAVAILABLE");
};

/** Публичный каталог туриста (блок 4, ADR-0019). Контракт; реализация — следующим шагом. */
@Injectable()
export class GuideService {
  categories(_regionId: string): Promise<GuideCategoryListDto> {
    return notImplemented();
  }

  search(_regionId: string, _params: SearchParams): Promise<PlaceSearchResultDto> {
    return notImplemented();
  }

  place(
    _regionId: string,
    _id: string,
    _opts: { origin?: LonLat; userId?: string },
  ): Promise<PlaceCardDto | undefined> {
    return notImplemented();
  }

  favorites(_regionId: string, _userId: string): Promise<FavoriteListDto> {
    return notImplemented();
  }

  addFavorite(_regionId: string, _userId: string, _placeId: string): Promise<FavoriteDto | undefined> {
    return notImplemented();
  }

  removeFavorite(_regionId: string, _userId: string, _placeId: string): Promise<void> {
    return notImplemented();
  }

  emergencyContacts(_regionId: string): Promise<EmergencyContact[]> {
    return notImplemented();
  }
}
