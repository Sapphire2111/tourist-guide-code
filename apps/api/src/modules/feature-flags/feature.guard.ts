import {
  applyDecorators,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiError } from "../../common/http/index.js";
import { isWithoutTenantContext } from "../../common/tenancy/index.js";
import { RequestAccess } from "../rbac/index.js";
import type { FeatureFlagKey } from "./catalog.js";
import { FeatureFlagsService } from "./feature-flags.service.js";

const REQUIRE_FEATURE = Symbol("REQUIRE_FEATURE");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Что видит резолвер региона. Guard выполняется до pipes: params/query/body ещё не провалидированы DTO. */
export type FeatureRegionResolveArgs = {
  readonly request: {
    readonly params?: Record<string, unknown>;
    readonly query?: Record<string, unknown>;
    readonly body?: unknown;
  };
};

/**
 * Регион запроса для флага, когда tenant-контекста региона нет (гость, турист, PLATFORM): как ScopeResolver в RBAC —
 * регион объекта запроса (заведение → его регион), а не произвольный выбор клиента. undefined — регион не
 * определён (значение окружения). Не uuid — тоже undefined.
 */
export type FeatureRegionResolver = (
  args: FeatureRegionResolveArgs,
) => string | null | undefined | Promise<string | null | undefined>;

/** Регион из параметра пути: `@RequireFeature("module.reviews", { region: regionFromParam("regionId") })`. */
export function regionFromParam(param: string): FeatureRegionResolver {
  return ({ request }) => {
    const v = request.params?.[param];
    return typeof v === "string" ? v : undefined;
  };
}

export type RequireFeatureOptions = {
  /** Резолвер региона, если у запроса нет tenant-контекста региона. Без него — значение уровня окружения. */
  readonly region?: FeatureRegionResolver;
};

type Requirement = { readonly key: FeatureFlagKey; readonly region?: FeatureRegionResolver };

/**
 * Включён ли флаг для запроса. Регион: tenant-контекст региона запроса (назначения принципала, RBAC) → резолвер
 * региона эндпоинта (`RequireFeatureOptions.region`) → нет; у эндпоинтов @WithoutTenantContext (турист) резолвер —
 * первым (значение уровня окружения; региональное
 * переопределение тогда не действует). Выбранный в сессии регион без назначения — 403, как в RequestAccess.
 * Регион туриста из QR-контекста (блок 2) подключается резолвером.
 */
@Injectable()
export class FeatureAccess {
  constructor(
    @Inject(FeatureFlagsService) private readonly flags: FeatureFlagsService,
    @Inject(RequestAccess) private readonly access: RequestAccess,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async isEnabled(
    context: ExecutionContext,
    key: FeatureFlagKey,
    region?: FeatureRegionResolver,
  ): Promise<boolean> {
    return this.flags.isEnabled(key, await this.regionOf(context, region));
  }

  private async regionOf(
    context: ExecutionContext,
    resolver?: FeatureRegionResolver,
  ): Promise<string | null> {
    const request = context.switchToHttp().getRequest<FeatureRegionResolveArgs["request"]>();
    const resolved = async () => {
      const region = resolver ? await resolver({ request }) : undefined;
      return typeof region === "string" && UUID.test(region) ? region.toLowerCase() : null;
    };
    // Эндпоинт без tenant-контекста (турист: регион — из запроса) — регион запроса, а не регион назначений
    // принципала: сотрудник отеля региона A, открывший гид региона B, получает флаг региона B (блок 5, ADR-0020).
    if (resolver && isWithoutTenantContext(this.reflector, context)) {
      const region = await resolved();
      if (region) return region;
    }
    const tenant = await this.access.tenant(context);
    if (tenant?.kind === "region") return tenant.regionId;
    return resolved();
  }
}

/**
 * Эндпоинт или контроллер модуля за фича-флагом: флаг выключен — 404 NOT_FOUND (выключенного модуля для клиента
 * нет). Ставить на класс модуля (или метод); в `@ApiErrors(…)` — "NOT_FOUND". Модулю нужен глобальный
 * FeatureFlagsModule (AppModule) — импортировать его не нужно. Для запросов без tenant-контекста региона (гость,
 * турист) регион задаёт `opts.region`, иначе действует значение окружения.
 */
export function RequireFeature(
  key: FeatureFlagKey,
  opts: RequireFeatureOptions = {},
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(REQUIRE_FEATURE, { key, region: opts.region } satisfies Requirement),
    UseGuards(FeatureGuard),
  );
}

@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(FeatureAccess) private readonly access: FeatureAccess,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // И класс, и метод: должны быть включены оба флага.
    const reqs = [
      this.reflector.get<Requirement | undefined>(REQUIRE_FEATURE, context.getClass()),
      this.reflector.get<Requirement | undefined>(REQUIRE_FEATURE, context.getHandler()),
    ].filter((r): r is Requirement => r !== undefined);
    if (!reqs.length) throw new Error("FeatureGuard без @RequireFeature: используйте декоратор");
    for (const r of reqs)
      if (!(await this.access.isEnabled(context, r.key, r.region))) throw new ApiError("NOT_FOUND");
    return true;
  }
}
