import { Module, type DynamicModule } from "@nestjs/common";
import { EmergencyContactsModule } from "../emergency-contacts/index.js";
import { RegionsModule } from "../regions/index.js";
import {
  FavoritesController,
  GuideCategoriesController,
  GuideEmergencyContactsController,
  GuideLocalitiesController,
  GuidePlacesController,
} from "./guide.controller.js";
import { GuideRepository } from "./guide.repository.js";
import { GuideService } from "./guide.service.js";
import { GOOGLE_PHOTOS_CONFIG, GooglePhotosService, type GooglePhotosConfig } from "./google-photos.js";

/**
 * Публичный каталог туриста (блок 4, ADR-0019): GET /categories, /localities, /places/search, /places/{id}, /emergency-contacts
 * и избранное /favorites. Db — глобальный DatabaseModule; ссылки на фото — MediaService (глобальный MediaModule).
 */
@Module({
  imports: [RegionsModule, EmergencyContactsModule],
  controllers: [
    GuideCategoriesController,
    GuideLocalitiesController,
    GuidePlacesController,
    FavoritesController,
    GuideEmergencyContactsController,
  ],
  providers: [GuideRepository, GuideService, GooglePhotosService],
  exports: [GuideService],
})
export class GuideModule {
  /** С настройками фото Google (ключ, публичный адрес api); без forRoot — фото Google не показываются. */
  static forRoot(config: GooglePhotosConfig): DynamicModule {
    return { module: GuideModule, providers: [{ provide: GOOGLE_PHOTOS_CONFIG, useValue: config }] };
  }
}
