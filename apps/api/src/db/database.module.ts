import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { createDatabase, type DatabaseOptions, type Db } from "./database.js";

/** DI-токен экземпляра Kysely (`Db`). В конструкторе: `@InjectDb() private readonly db: Db`. */
export const DATABASE = Symbol("DATABASE");

export const InjectDb = (): ParameterDecorator => Inject(DATABASE);

/** Закрывает пул при остановке приложения (app.close(), SIGTERM при enableShutdownHooks). */
@Injectable()
class DatabaseShutdown implements OnApplicationShutdown {
  constructor(@InjectDb() private readonly db: Db) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

/**
 * Глобальный модуль БД: один пул на процесс. Строка подключения — из проверенного env
 * (DATABASE_URL в apiEnvSchema): `DatabaseModule.forRoot({ connectionString: env.DATABASE_URL })`.
 */
@Global()
@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseOptions): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [{ provide: DATABASE, useFactory: (): Db => createDatabase(options) }, DatabaseShutdown],
      exports: [DATABASE],
    };
  }
}
