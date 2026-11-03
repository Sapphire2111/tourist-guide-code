/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Имя нашего бота (без @): ссылки на других ботов считаются чужими. */
  readonly VITE_BOT_USERNAME?: string;
}
