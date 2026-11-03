// Публичный интерфейс контекста guide (блок 4, публичный каталог туриста; ADR-0019).
export {
  FavoritesController,
  GuideCategoriesController,
  GuideEmergencyContactsController,
  GuideLocalitiesController,
  GuidePlacesController,
  originOf,
  SEARCH_RATE_LIMIT,
} from "./guide.controller.js";
export {
  AddFavoriteDto,
  FavoriteDto,
  FavoriteListDto,
  GuideCategoryDto,
  GuideCategoryListDto,
  GuideLocalityDto,
  GuideLocalityListDto,
  PlaceCardDto,
  PlacePhotoDto,
  PlaceSearchResultDto,
  PlaceSummaryDto,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SEARCH_RADIUS_DEFAULT,
  SEARCH_RADIUS_MAX,
} from "./guide.dto.js";
export { GuideModule } from "./guide.module.js";
export { FAVORITES_MAX, GuideRepository, likeContains } from "./guide.repository.js";
export { GuideService, type SearchParams } from "./guide.service.js";
export { localMoment, openState, type LocalMoment, type OpenState, type ScheduleRows } from "./open-now.js";
export { LOCALITY_ALIASES, localityAliases } from "./locality-aliases.js";
