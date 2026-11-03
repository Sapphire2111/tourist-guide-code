import { Module, type DynamicModule } from "@nestjs/common";
import { WeatherController } from "./weather.controller.js";
import { WeatherRefresher } from "./weather.refresher.js";
import { WeatherRepository } from "./weather.repository.js";
import { WEATHER_CONFIG, WeatherService, type WeatherConfig } from "./weather.service.js";

/**
 * Прогноз погоды (флаг module.weather): GET /weather для главной Mini App, WeatherService — для «Мій план» (модуль
 * глобальный). Снимки по точкам — weather_forecasts (0026); источник — Google Weather (серверный ключ, квота), запасной
 * — Open-Meteo. Db — глобальный DatabaseModule. Без refresh — без фонового тика (только ленивое обновление).
 */
@Module({})
export class WeatherModule {
  static forRoot(config: WeatherConfig = {}): DynamicModule {
    return {
      module: WeatherModule,
      global: true,
      controllers: [WeatherController],
      providers: [
        { provide: WEATHER_CONFIG, useValue: config },
        WeatherRepository,
        WeatherService,
        WeatherRefresher,
      ],
      exports: [WeatherService],
    };
  }
}
