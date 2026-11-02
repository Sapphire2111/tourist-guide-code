import {
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { createErrorTracker, type ErrorTracker } from "@tg/server-config";
import type { BotEnv } from "./config.js";
import { BullOutbox, createSendMessageProcessor, MemoryOutbox, type Outbox } from "./queue/outbox.js";
import { LoggingStartContextSink, START_CONTEXT_SINK } from "./start-context.js";
import { BotApiClient } from "./telegram/bot-api.js";
import { BOT_ENV, ERROR_TRACKER, OUTBOX } from "./tokens.js";
import { WebhookController } from "./webhook.controller.js";

/** Закрывает очередь при остановке (SIGTERM → app.close()), затем дожидается отправки событий трекера. */
@Injectable()
class OutboxShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(ERROR_TRACKER) private readonly tracker: ErrorTracker,
  ) {}
  async onApplicationShutdown(): Promise<void> {
    await this.outbox.close();
    await this.tracker.flush(2000);
  }
}

/** Очередь по env: есть REDIS_URL → BullMQ, иначе (допустимо только в local, см. config) — в памяти. */
export function createOutbox(env: BotEnv): Outbox {
  const logger = new Logger("Outbox");
  const send = env.TELEGRAM_BOT_TOKEN
    ? createSendMessageProcessor(new BotApiClient({ token: env.TELEGRAM_BOT_TOKEN }))
    : async () => logger.warn("TELEGRAM_BOT_TOKEN не задан — сообщение не отправлено");
  return env.REDIS_URL ? new BullOutbox(env.REDIS_URL, send, logger) : new MemoryOutbox(send, logger);
}

@Module({})
export class AppModule {
  static forRoot(env: BotEnv, outbox: Outbox = createOutbox(env)): DynamicModule {
    return {
      module: AppModule,
      controllers: [WebhookController],
      providers: [
        { provide: BOT_ENV, useValue: env },
        { provide: OUTBOX, useValue: outbox },
        {
          provide: ERROR_TRACKER,
          useValue: createErrorTracker({
            service: "bot",
            environment: env.APP_ENV,
            dsn: env.SENTRY_DSN,
            logger: new Logger("ErrorTracker"),
          }),
        },
        { provide: START_CONTEXT_SINK, useValue: new LoggingStartContextSink(new Logger("StartContext")) },
        OutboxShutdown,
      ],
    };
  }
}
