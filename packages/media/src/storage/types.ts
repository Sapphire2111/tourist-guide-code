/** Подписанная ссылка на загрузку: клиент делает PUT по url с этими заголовками и телом-файлом. */
export interface PresignedUpload {
  url: string;
  method: "PUT";
  /** Заголовки, которые клиент обязан отправить (входят в подпись). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface PresignPutOptions {
  contentType: string;
  /** Точный размер тела, байт: входит в подпись (S3 — Content-Length, local — проверка при приёме). */
  contentLength: number;
  expiresInSeconds: number;
}

export interface PresignGetOptions {
  /** Content-Type ответа (local отдаёт его; S3 — ResponseContentType). */
  contentType: string;
  expiresInSeconds: number;
  /** Скачивание как файл (Content-Disposition: attachment) — для документов. */
  download?: boolean;
}

/**
 * Хранилище объектов с интерфейсом S3: подписанные ссылки на загрузку (PUT) и чтение (GET) плюс серверные операции
 * (размер и первые байты для проверки, чтение/запись для ресайза, удаление). Драйверы: s3 (любое S3-совместимое) и
 * local (файлы + HMAC-подпись, ссылки ведут на сам api). Ключ — `private/…` или `public/…` (constants.ts).
 */
export interface StorageDriver {
  readonly driver: "s3" | "local";
  presignPut(key: string, options: PresignPutOptions): Promise<PresignedUpload>;
  presignGet(key: string, options: PresignGetOptions): Promise<string>;
  /** Размер объекта, байт; нет объекта — null. */
  size(key: string): Promise<number | null>;
  /** Первые `length` байт объекта (меньше, если объект короче); нет объекта — null. */
  readHead(key: string, length: number): Promise<Uint8Array | null>;
  /** Объект целиком; нет — null. */
  read(key: string): Promise<Buffer | null>;
  write(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Серверная копия объекта (перезаписывает цель); нет источника — false. */
  copy(fromKey: string, toKey: string): Promise<boolean>;
  /** Удаление; отсутствующий объект — не ошибка (повтор безопасен). */
  delete(key: string): Promise<void>;
}

/** Ключ объекта: только безопасные символы, без «..» и пустых сегментов (защита от выхода за корень local). */
export function isValidStorageKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 512 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(key) &&
    !key.split("/").some((s) => s === "." || s === "..")
  );
}

export function assertValidStorageKey(key: string): void {
  if (!isValidStorageKey(key)) throw new Error("Недопустимый ключ объекта хранилища");
}
