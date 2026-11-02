// ВРЕМЕННО: до контракта блока 5 (b5-api).
import type { ApiClient } from "@tg/api-client";
import type { Me, QrContext } from "../session.js";
import { noopHostApi } from "./context.js";
import type { HostApi } from "./types.js";
export function createHostApi(_api: ApiClient, _regionId: string | null): HostApi {
  return noopHostApi();
}
export function isStaff(_me: Me): boolean {
  return false;
}
export function roomFromContext(_c: QrContext | null): string | null {
  return null;
}
