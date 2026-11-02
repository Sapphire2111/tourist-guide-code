import { Module } from "@nestjs/common";
import { EmergencyContactsModule } from "../emergency-contacts/index.js";
import { RegionsModule } from "../regions/index.js";
import {
  FavoritesController,
  GuideCategoriesController,
  GuideEmergencyContactsController,
  GuidePlacesController,
} from "./guide.controller.js";
import { GuideRepository } from "./guide.repository.js";
import { GuideService } from "./guide.service.js";

/**
 * Публичный каталог туриста (блок 4, ADR-0019): GET /categories, /places/search, /places/{id}, /emergency-contacts
 * и избранное /favorites. Db — глобальный DatabaseModule; ссылки на фото — MediaService (глобальный MediaModule).
 */
@Module({
  imports: [RegionsModule, EmergencyContactsModule],
  controllers: [
    GuideCategoriesController,
    GuidePlacesController,
    FavoritesController,
    GuideEmergencyContactsController,
  ],
  providers: [GuideRepository, GuideService],
  exports: [GuideService],
})
export class GuideModule {}
