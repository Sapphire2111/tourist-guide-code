// Публичный интерфейс модуля погоды: прогноз по точке, предупреждения, правила для планировщика.
export { WeatherModule } from "./weather.module.js";
export {
  GOOGLE_WEATHER_DAILY_LIMIT_DEFAULT,
  GOOGLE_WEATHER_MONTHLY_LIMIT_DEFAULT,
  WeatherService,
  type WeatherConfig,
} from "./weather.service.js";
export { WeatherDayDto, toDayDto } from "./weather.dto.js";
export {
  HIKE_RELEVANT,
  hikeUnsafe,
  WEATHER_SOURCES,
  WEATHER_WARNINGS,
  type Forecast,
  type WeatherDay,
  type WeatherSource,
  type WeatherWarning,
} from "./weather-rules.js";
// Горные точки прогноза — для погоды «на вершині» (раздел «Вершини»).
export { meters, MOUNTAIN_POINTS } from "./weather-points.js";
