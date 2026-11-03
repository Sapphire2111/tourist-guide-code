import { Controller, Get, Inject, Query, Res } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { RequireFeature, type FeatureRegionResolver } from "../feature-flags/index.js";
import { RateLimit } from "../rate-limit/index.js";
import { WeatherForecastDto, toForecastDto } from "./weather.dto.js";
// Класс DTO запроса нужен в рантайме: emitDecoratorMetadata передаёт его в ValidationPipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { WeatherQueryDto } from "./weather.dto.js";
import { FORECAST_DAYS_DEFAULT } from "./weather-rules.js";
import { WeatherService } from "./weather.service.js";

const queryRegion: FeatureRegionResolver = ({ request }) => {
  const q = request.query?.regionId;
  return typeof q === "string" ? q : undefined;
};

/** Лимит на IP/пользователя: ответ из снимков по точкам, но устаревший снимок обновляется у источника. */
export const WEATHER_RATE_LIMIT = { limit: 30, windowSec: 60 } as const;

/** Прогноз погоды для главной и «Мій план» (флаг module.weather): без сессии, данные публичные. */
@ApiTags("weather")
@Controller("weather")
@WithoutTenantContext()
@RequireFeature("module.weather", { region: queryRegion })
export class WeatherController {
  constructor(@Inject(WeatherService) private readonly weather: WeatherService) {}

  @Get()
  @RateLimit(WEATHER_RATE_LIMIT)
  @ApiOperation({
    operationId: "getWeather",
    summary: "Прогноз погоды на 1–7 дней с предупреждениями — из ближайшей точки прогноза (не дальше 30 км)",
    description:
      "Без аутентификации. Прогноз хранится у нас по точкам (центры населённых пунктов, горные точки); источник — " +
      "Google Weather, запасной — Open-Meteo. Нет точки рядом или прогноза — 200 с available: false и пустыми days " +
      "(не 500). Подпись источника — по полю source. 404 — флаг module.weather выключен.",
  })
  @ApiOkResponse({ type: WeatherForecastDto })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND", "RATE_LIMITED")
  async get(
    @Query() q: WeatherQueryDto,
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): unknown },
  ): Promise<WeatherForecastDto> {
    const dto = toForecastDto(
      await this.weather.forecastAt({ lat: q.lat, lng: q.lng }),
      q.days ?? FORECAST_DAYS_DEFAULT,
    );
    // Ответ одинаков для всех: публичный кеш на 10 минут; «прогноза нет» не кешируется (источник может ожить).
    res.setHeader("Cache-Control", dto.available ? "public, max-age=600" : "no-store");
    return dto;
  }
}
