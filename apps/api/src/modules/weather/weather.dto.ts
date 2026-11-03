import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsNumber, IsOptional, IsUUID, Max, Min } from "class-validator";
import {
  FORECAST_DAYS_DEFAULT,
  FORECAST_DAYS_MAX,
  WEATHER_CONDITIONS,
  WEATHER_SOURCES,
  WEATHER_WARNINGS,
  type Forecast,
  type WeatherCondition,
  type WeatherDay,
  type WeatherSource,
  type WeatherWarning,
} from "./weather-rules.js";

// DTO прогноза погоды (GET /weather). Подпись источника у клиента: Google — «Includes weather data from Google»,
// Open-Meteo — «Дані: Open-Meteo» (CC BY 4.0).

const CONDITION = {
  enum: WEATHER_CONDITIONS,
  enumName: "WeatherCondition",
  nullable: true,
  description: "Погода одним словом — свой текст и иконка клиента, если у источника нет iconUrl",
} as const;
const DESCRIPTION = {
  type: String,
  nullable: true,
  description: "Описание источника на украинском (Google); Open-Meteo — null",
} as const;
const ICON = {
  type: String,
  nullable: true,
  description: "Иконка Google (https://maps.gstatic.com/weather/….svg); null — своя по condition",
} as const;

export class WeatherQueryDto {
  @ApiProperty({ type: Number, minimum: -90, maximum: 90, example: 48.31, description: "Широта" })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty({ type: Number, minimum: -180, maximum: 180, example: 25.09, description: "Долгота" })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng!: number;

  @ApiPropertyOptional({
    type: "integer",
    minimum: 1,
    maximum: FORECAST_DAYS_MAX,
    default: FORECAST_DAYS_DEFAULT,
    description: "Дней прогноза, начиная с сегодняшнего (по местному времени точки)",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FORECAST_DAYS_MAX)
  days?: number;

  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    description: "Регион туриста (GET /context) — для флага module.weather региона",
  })
  @IsOptional()
  @IsUUID()
  regionId?: string;
}

export class WeatherDayDto {
  @ApiProperty({ type: String, format: "date", description: "Местная дата точки" }) date!: string;

  @ApiProperty(CONDITION) condition!: WeatherCondition | null;
  @ApiProperty(DESCRIPTION) description!: string | null;
  @ApiProperty(ICON) iconUrl!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: "°C" }) temperatureMax!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: "°C" }) temperatureMin!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: "Осадки за сутки, мм" })
  precipitationSum!: number | null;
  @ApiProperty({ type: "integer", nullable: true, description: "Вероятность осадков, %" })
  precipitationProbabilityMax!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: "Снег за сутки, см" }) snowfallSum!:
    | number
    | null;
  @ApiProperty({ type: Number, nullable: true, description: "Ветер, км/ч" }) windSpeedMax!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: "Порывы ветра, км/ч" }) windGustsMax!:
    | number
    | null;

  @ApiProperty({ type: Boolean, description: "Ожидается дождь — показать запасной план «якщо дощ»" })
  rainy!: boolean;

  @ApiProperty({
    enum: WEATHER_WARNINGS,
    enumName: "WeatherWarning",
    isArray: true,
    description:
      "Предупреждения: thunderstorm — гроза; heavy_rain — от 20 мм; strong_wind — порывы от 60 км/ч или ветер от " +
      "40 км/ч; frost — от −10 °C; heavy_snow — от 10 см; ice — ледяной дождь/морось; heat — от 32 °C",
  })
  warnings!: WeatherWarning[];
}

export class WeatherNowDto {
  @ApiProperty({ type: String, nullable: true, description: "Время замера (ISO)" }) time!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: "°C" }) temperature!: number | null;
  @ApiProperty(CONDITION) condition!: WeatherCondition | null;
  @ApiProperty(DESCRIPTION) description!: string | null;
  @ApiProperty(ICON) iconUrl!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: "км/ч" }) windSpeed!: number | null;
  @ApiProperty({ type: Boolean, nullable: true }) isDay!: boolean | null;
}

export class WeatherPointDto {
  @ApiProperty({ type: Number }) lat!: number;
  @ApiProperty({ type: Number }) lng!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Высота точки по рельефу источника, м (Google — null)",
  })
  elevation!: number | null;
}

export class WeatherForecastDto {
  @ApiProperty({
    type: Boolean,
    description: "false — источник недоступен: прогноза нет (клиент ничего не показывает)",
  })
  available!: boolean;

  @ApiProperty({
    enum: WEATHER_SOURCES,
    enumName: "WeatherSource",
    nullable: true,
    description: "google — подпись «Includes weather data from Google»; open-meteo — «Дані: Open-Meteo»",
  })
  source!: WeatherSource | null;

  @ApiProperty({ type: WeatherPointDto, nullable: true }) point!: WeatherPointDto | null;
  @ApiProperty({ type: String, nullable: true, example: "Europe/Kyiv" }) timezone!: string | null;
  @ApiProperty({ type: WeatherNowDto, nullable: true }) current!: WeatherNowDto | null;
  @ApiProperty({ type: [WeatherDayDto] }) days!: WeatherDayDto[];
}

export function toDayDto(d: WeatherDay): WeatherDayDto {
  return { ...d, warnings: [...d.warnings] };
}

export function toForecastDto(f: Forecast | null, days: number): WeatherForecastDto {
  if (!f) return { available: false, source: null, point: null, timezone: null, current: null, days: [] };
  return {
    available: f.days.length > 0,
    source: f.source,
    point: { lat: f.latitude, lng: f.longitude, elevation: f.elevation },
    timezone: f.timezone,
    current: f.current,
    days: f.days.slice(0, days).map(toDayDto),
  };
}
