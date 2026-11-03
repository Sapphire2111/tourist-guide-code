import { Controller, Get, Inject, Param, Query, Res } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { ApiError, ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { RequireFeature, type FeatureRegionResolver } from "../feature-flags/index.js";
import { RateLimit, SkipIpRateLimit } from "../rate-limit/index.js";
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
/** Иконки грузятся <img> без Bearer — свой лимит без общего лимита IP (туристы за одним Wi-Fi). */
export const WEATHER_ICON_RATE_LIMIT = { limit: 300, windowSec: 60 } as const;
const ICON_CACHE_SEC = 7 * 24 * 3600;

type BinaryResponse = {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  end(body?: Buffer): unknown;
};

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

  @Get("icons/:file")
  @RateLimit(WEATHER_ICON_RATE_LIMIT)
  @SkipIpRateLimit()
  @ApiOperation({
    operationId: "getWeatherIcon",
    summary: "Иконка погоды Google (прокси): адрес — iconUrl прогноза",
    description:
      "Без аутентификации. SVG с maps.gstatic.com через api — Mini App к Google не ходит. Cache-Control public на " +
      "неделю. 404 — иконки нет.",
  })
  @ApiParam({ name: "file", type: String, example: "cloudy.svg" })
  @ApiResponse({ status: 200, description: "image/svg+xml" })
  @ApiErrors("NOT_FOUND", "RATE_LIMITED")
  async icon(@Param("file") file: string, @Res() res: BinaryResponse): Promise<void> {
    const name = /^([a-z0-9_]{1,60})\.svg$/.exec(file)?.[1];
    const bytes = name ? await this.weather.icon(name) : null;
    if (!bytes) throw new ApiError("NOT_FOUND");
    res.status(200);
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Content-Length", String(bytes.length));
    res.setHeader("Cache-Control", `public, max-age=${ICON_CACHE_SEC}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Чужой SVG с нашего адреса: без скриптов и внешних ресурсов, даже если открыть его напрямую.
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.end(bytes);
  }
}
