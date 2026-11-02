import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { ApiErrors } from "../../common/http/index.js";
import type { AuditableRequest } from "../audit/index.js";
import { RequirePermission, scopeFromTenant } from "../rbac/index.js";
import { auditMeta, call, uuid } from "./catalog-http.js";
import {
  categoryInput,
  CategoryDto,
  CategoryListDto,
  localityInput,
  LocalityDto,
  LocalityListDto,
  tagInput,
  TagDto,
  TagListDto,
  toCategoryDto,
  toLocalityDto,
  toTagDto,
} from "./catalog.dto.js";
// Классы DTO нужны в рантайме: emitDecoratorMetadata передаёт их в ValidationPipe (import type сломает валидацию).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CreateCategoryDto,
  CreateLocalityDto,
  CreateTagDto,
  UpdateCategoryDto,
  UpdateLocalityDto,
  UpdateTagDto,
} from "./catalog.dto.js";
import { CatalogService } from "./catalog.service.js";

// Справочники региона (блок 3): населённые пункты, категории, теги. Регион — из tenant-контекста запроса; запись
// другого региона не видна (TenantGuardPlugin + RLS) — 404. Списки небольшие — без пагинации.

const READ = "catalog.read.admin";
const READ_ERRORS = ["UNAUTHENTICATED", "FORBIDDEN"] as const;
const ITEM_ERRORS = ["VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND"] as const;
const WRITE_ERRORS = [...ITEM_ERRORS, "CONFLICT", "UNPROCESSABLE"] as const;

@ApiTags("admin")
@Controller("admin/localities")
export class LocalitiesController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get()
  @RequirePermission(READ, scopeFromTenant)
  @ApiOperation({ operationId: "listLocalities", summary: "Населённые пункты региона" })
  @ApiOkResponse({ type: LocalityListDto })
  @ApiErrors(...READ_ERRORS)
  async list(): Promise<LocalityListDto> {
    return { items: (await call(() => this.catalog.listLocalities())).map(toLocalityDto) };
  }

  @Get(":id")
  @RequirePermission(READ, scopeFromTenant)
  @ApiOperation({ operationId: "getLocality", summary: "Населённый пункт" })
  @ApiOkResponse({ type: LocalityDto })
  @ApiErrors(...ITEM_ERRORS)
  async get(@Param("id", uuid) id: string): Promise<LocalityDto> {
    return toLocalityDto(await call(() => this.catalog.getLocality(id)));
  }

  @Post()
  @RequirePermission("locality.manage", scopeFromTenant)
  @ApiOperation({ operationId: "createLocality", summary: "Новый населённый пункт" })
  @ApiCreatedResponse({ type: LocalityDto })
  @ApiErrors(...WRITE_ERRORS)
  async create(@Body() body: CreateLocalityDto, @Req() req: AuditableRequest): Promise<LocalityDto> {
    const input = localityInput(body);
    return toLocalityDto(
      await call(() =>
        this.catalog.createLocality(auditMeta(req), { ...input, code: body.code, name: { ...body.name } }),
      ),
    );
  }

  @Patch(":id")
  @RequirePermission("locality.manage", scopeFromTenant)
  @ApiOperation({ operationId: "updateLocality", summary: "Изменить населённый пункт" })
  @ApiOkResponse({ type: LocalityDto })
  @ApiErrors(...WRITE_ERRORS)
  async update(
    @Param("id", uuid) id: string,
    @Body() body: UpdateLocalityDto,
    @Req() req: AuditableRequest,
  ): Promise<LocalityDto> {
    return toLocalityDto(
      await call(() => this.catalog.updateLocality(auditMeta(req), id, localityInput(body))),
    );
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("locality.manage", scopeFromTenant)
  @ApiOperation({ operationId: "deleteLocality", summary: "Удалить (если на него не ссылаются места)" })
  @ApiNoContentResponse()
  @ApiErrors(...WRITE_ERRORS)
  async remove(@Param("id", uuid) id: string, @Req() req: AuditableRequest): Promise<void> {
    await call(() => this.catalog.deleteLocality(auditMeta(req), id));
  }
}

@ApiTags("admin")
@Controller("admin/categories")
export class CategoriesController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get()
  @RequirePermission(READ, scopeFromTenant)
  @ApiOperation({ operationId: "listCategories", summary: "Категории региона (корневые и подкатегории)" })
  @ApiOkResponse({ type: CategoryListDto })
  @ApiErrors(...READ_ERRORS)
  async list(): Promise<CategoryListDto> {
    return { items: (await call(() => this.catalog.listCategories())).map(toCategoryDto) };
  }

  @Get(":id")
  @RequirePermission(READ, scopeFromTenant)
  @ApiOperation({ operationId: "getCategory", summary: "Категория" })
  @ApiOkResponse({ type: CategoryDto })
  @ApiErrors(...ITEM_ERRORS)
  async get(@Param("id", uuid) id: string): Promise<CategoryDto> {
    return toCategoryDto(await call(() => this.catalog.getCategory(id)));
  }

  @Post()
  @RequirePermission("category.manage.regional", scopeFromTenant)
  @ApiOperation({ operationId: "createCategory", summary: "Новая категория (один уровень вложенности)" })
  @ApiCreatedResponse({ type: CategoryDto })
  @ApiErrors(...WRITE_ERRORS)
  async create(@Body() body: CreateCategoryDto, @Req() req: AuditableRequest): Promise<CategoryDto> {
    const input = categoryInput(body);
    return toCategoryDto(
      await call(() =>
        this.catalog.createCategory(auditMeta(req), { ...input, code: body.code, name: { ...body.name } }),
      ),
    );
  }

  @Patch(":id")
  @RequirePermission("category.manage.regional", scopeFromTenant)
  @ApiOperation({ operationId: "updateCategory", summary: "Изменить категорию" })
  @ApiOkResponse({ type: CategoryDto })
  @ApiErrors(...WRITE_ERRORS)
  async update(
    @Param("id", uuid) id: string,
    @Body() body: UpdateCategoryDto,
    @Req() req: AuditableRequest,
  ): Promise<CategoryDto> {
    return toCategoryDto(
      await call(() => this.catalog.updateCategory(auditMeta(req), id, categoryInput(body))),
    );
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("category.manage.regional", scopeFromTenant)
  @ApiOperation({ operationId: "deleteCategory", summary: "Удалить (без подкатегорий и мест)" })
  @ApiNoContentResponse()
  @ApiErrors(...WRITE_ERRORS)
  async remove(@Param("id", uuid) id: string, @Req() req: AuditableRequest): Promise<void> {
    await call(() => this.catalog.deleteCategory(auditMeta(req), id));
  }
}

@ApiTags("admin")
@Controller("admin/tags")
export class TagsController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get()
  @RequirePermission(READ, scopeFromTenant)
  @ApiOperation({ operationId: "listTags", summary: "Теги региона" })
  @ApiOkResponse({ type: TagListDto })
  @ApiErrors(...READ_ERRORS)
  async list(): Promise<TagListDto> {
    return { items: (await call(() => this.catalog.listTags())).map(toTagDto) };
  }

  @Get(":id")
  @RequirePermission(READ, scopeFromTenant)
  @ApiOperation({ operationId: "getTag", summary: "Тег" })
  @ApiOkResponse({ type: TagDto })
  @ApiErrors(...ITEM_ERRORS)
  async get(@Param("id", uuid) id: string): Promise<TagDto> {
    return toTagDto(await call(() => this.catalog.getTag(id)));
  }

  @Post()
  @RequirePermission("tag.manage", scopeFromTenant)
  @ApiOperation({ operationId: "createTag", summary: "Новый тег" })
  @ApiCreatedResponse({ type: TagDto })
  @ApiErrors(...WRITE_ERRORS)
  async create(@Body() body: CreateTagDto, @Req() req: AuditableRequest): Promise<TagDto> {
    const input = tagInput(body);
    return toTagDto(
      await call(() =>
        this.catalog.createTag(auditMeta(req), { ...input, code: body.code, name: { ...body.name } }),
      ),
    );
  }

  @Patch(":id")
  @RequirePermission("tag.manage", scopeFromTenant)
  @ApiOperation({ operationId: "updateTag", summary: "Изменить тег" })
  @ApiOkResponse({ type: TagDto })
  @ApiErrors(...WRITE_ERRORS)
  async update(
    @Param("id", uuid) id: string,
    @Body() body: UpdateTagDto,
    @Req() req: AuditableRequest,
  ): Promise<TagDto> {
    return toTagDto(await call(() => this.catalog.updateTag(auditMeta(req), id, tagInput(body))));
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("tag.manage", scopeFromTenant)
  @ApiOperation({ operationId: "deleteTag", summary: "Удалить тег (связи с местами снимаются)" })
  @ApiNoContentResponse()
  @ApiErrors(...WRITE_ERRORS)
  async remove(@Param("id", uuid) id: string, @Req() req: AuditableRequest): Promise<void> {
    await call(() => this.catalog.deleteTag(auditMeta(req), id));
  }
}
