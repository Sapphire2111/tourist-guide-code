// Клиент API: адрес — переменная сборки VITE_API_URL (на Render задаётся в сервисе), локально — api на 4300.
import { createApiClient } from "@tg/api-client";

export const API_URL: string = import.meta.env.VITE_API_URL || "http://localhost:4300";

export const api = createApiClient({ baseUrl: API_URL });
