import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from "@nestjs/swagger";
import type { HealthStatus } from "@tg/shared";
import { ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { SkipRateLimit } from "../rate-limit/index.js";

class HealthStatusDto implements HealthStatus {
  @ApiProperty({ enum: ["ok"], enumName: "HealthStatusValue" }) status!: "ok";
}

/**
 * Живость процесса. Без tenant-контекста: health не читает данных региона, и запрос с Bearer-токеном сессии
 * (выбранный регион больше не разрешён) не должен получать 403 или открывать транзакцию запроса.
 */
@ApiTags("health")
@WithoutTenantContext()
@SkipRateLimit() // проверка живости платформы (Render) не должна получать 429
@Controller("health")
export class HealthController {
  @Get()
  @ApiOperation({ operationId: "getHealth", summary: "Проверка живости процесса" })
  @ApiOkResponse({ type: HealthStatusDto, description: "Процесс жив" })
  @ApiErrors()
  get(): HealthStatus {
    return { status: "ok" };
  }
}
