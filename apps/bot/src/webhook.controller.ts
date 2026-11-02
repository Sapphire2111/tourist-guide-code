import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { runWithLogContext, type ErrorTracker } from "@tg/server-config";
import type { BotEnv } from "./config.js";
import { botIdFromToken } from "./queue/contract.js";
import type { Outbox } from "./queue/outbox.js";
import { START_CONTEXT_SINK, type StartContextSink } from "./start-context.js";
import { isTgUpdate } from "./telegram/types.js";
import { isValidWebhookSecret, SECRET_HEADER } from "./telegram/webhook-secret.js";
import { BOT_ENV, ERROR_TRACKER, OUTBOX } from "./tokens.js";
import { handleUpdate } from "./update-handler.js";

export const WEBHOOK_PATH = "/telegram/webhook";

/** Приём webhook Telegram: 200 сразу после постановки ответа в очередь. */
@Controller("telegram")
export class WebhookController {
  private readonly logger = new Logger("Webhook");
  private readonly botId: string;

  constructor(
    @Inject(BOT_ENV) private readonly env: BotEnv,
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(START_CONTEXT_SINK) private readonly startSink: StartContextSink,
    @Inject(ERROR_TRACKER) private readonly tracker: ErrorTracker,
  ) {
    this.botId = botIdFromToken(env.TELEGRAM_BOT_TOKEN);
  }

  @Post("webhook")
  @HttpCode(200)
  async receive(@Headers(SECRET_HEADER) secret: unknown, @Body() body: unknown): Promise<void> {
    // Без подсказок в теле: неверный и отсутствующий секрет неразличимы.
    if (!isValidWebhookSecret(secret, this.env.TELEGRAM_WEBHOOK_SECRET)) throw new UnauthorizedException();
    if (!isTgUpdate(body)) {
      this.logger.warn("webhook: тело не похоже на Update — пропущено");
      return; // 200: иначе Telegram будет повторять доставку
    }
    // correlationId логов (T1-18) — по update_id: тот же id у повторной доставки Telegram.
    await runWithLogContext({ correlationId: `tg-update:${body.update_id}` }, () => this.handle(body));
  }

  private async handle(body: Parameters<typeof handleUpdate>[0]): Promise<void> {
    try {
      await handleUpdate(body, {
        outbox: this.outbox,
        startSink: this.startSink,
        miniappBaseUrl: this.env.PUBLIC_MINIAPP_URL,
        miniappLink: this.env.TELEGRAM_MINIAPP_LINK,
        botId: this.botId,
        logger: this.logger,
      });
    } catch (err) {
      // Очередь недоступна: 500 → Telegram повторит доставку (jobId по update_id защищает от дублей).
      this.logger.error(`update_id=${body.update_id}: обработка не удалась: ${(err as Error).message}`);
      this.tracker.captureException(err, { updateId: body.update_id });
      throw err;
    }
  }
}
