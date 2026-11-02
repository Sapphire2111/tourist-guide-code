/** Контекст входа по deep link: что бот передаёт в API (блок 2). Без ПДн: только числовой id и payload. */
export interface StartContext {
  telegramUserId: number;
  payload: string;
  updateId: number;
}

/**
 * Порт передачи start-параметра в API — основной (доверенный) канал контекста входа: query у web_app-кнопки
 * не подписан. Приёмник обязан быть идемпотентным по updateId: Telegram повторяет доставку webhook.
 */
export interface StartContextSink {
  record(ctx: StartContext): Promise<void>;
}

export const START_CONTEXT_SINK = Symbol("START_CONTEXT_SINK");

/**
 * Заглушка: пишет в лог факт входа (update_id и длину payload, без id пользователя).
 * TODO блок 2: QR/EntryContext в api — заменить на HTTP-клиент к эндпоинту api (QRScanEvent/EntryContext).
 */
export class LoggingStartContextSink implements StartContextSink {
  constructor(private readonly logger: { log(message: string): void }) {}

  async record(ctx: StartContext): Promise<void> {
    this.logger.log(`start-контекст update_id=${ctx.updateId} payload_len=${ctx.payload.length}`);
  }
}
