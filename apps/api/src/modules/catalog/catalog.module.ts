import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import { RbacModule } from "../rbac/index.js";
import { RegionsModule } from "../regions/index.js";
import { CatalogRepository } from "./catalog.repository.js";
import { CatalogService } from "./catalog.service.js";
import { CategoriesController, LocalitiesController, TagsController } from "./dictionaries.controller.js";
import { PlacesController } from "./places.controller.js";
import { RegionsAdminController } from "./regions-admin.controller.js";
import { RegionsAdminService } from "./regions-admin.service.js";

/**
 * Каталог региона для админки (блок 3, ADR-0017): /admin/regions, /admin/localities, /admin/categories, /admin/tags,
 * /admin/places (+ статусы, график, фото, бейдж). Публичная выдача туристу — блок 4. Db — глобальный DatabaseModule.
 */
@Module({
  // RbacModule: guard @RequirePermission; AuditModule: запись изменений; RegionsModule: регионы (глобальная таблица).
  imports: [RbacModule, AuditModule, RegionsModule],
  controllers: [
    RegionsAdminController,
    LocalitiesController,
    CategoriesController,
    TagsController,
    PlacesController,
  ],
  providers: [CatalogRepository, CatalogService, RegionsAdminService],
  exports: [CatalogRepository, CatalogService],
})
export class CatalogModule {}
