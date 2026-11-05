// Мок api прайса заведения (миграция 0030) для E2E Mini App: кабинет /partner/places/{id}/price-list/* и «Ціни»
// карточки /places/{id}/price-list. Состояние — на страницу; правила (версия, порядок, архив, видимость туристу) —
// как в PriceListService сервера, упрощённо. Остальные пути — дальше другим мокам (route.fallback).
import type { Page, Route } from "@playwright/test";

type Item = {
  id: string;
  sectionId: string;
  name: { uk: string };
  description: { uk: string } | null;
  priceMinor: number;
  currency: "UAH";
  priceFrom: boolean;
  unit: { uk: string } | null;
  hidden: boolean;
  sortOrder: number;
  version: number;
  updatedAt: string;
};
type Section = {
  id: string;
  title: { uk: string };
  hidden: boolean;
  sortOrder: number;
  version: number;
};

export type PriceListMockState = { sections: Section[]; items: Item[]; requests: string[] };

const NOW = "2026-11-05T10:00:00.000Z";

export async function installPriceListMock(page: Page, placeId: string): Promise<PriceListMockState> {
  const state: PriceListMockState = { sections: [], items: [], requests: [] };
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(0xe000 + ++n).padStart(12, "0")}`;
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
  const sorted = <T extends { sortOrder: number }>(rows: T[]) =>
    [...rows].sort((a, b) => a.sortOrder - b.sortOrder);
  const dto = () => ({
    placeId,
    itemCount: state.items.length,
    limits: { maxItems: 200, maxSections: 30 },
    sections: sorted(state.sections).map((s) => ({
      ...s,
      items: sorted(state.items.filter((i) => i.sectionId === s.id)),
    })),
  });
  const swap = <T extends { id: string; sortOrder: number; version: number }>(
    rows: T[],
    rowId: string,
    direction: string,
  ) => {
    const list = sorted(rows);
    const i = list.findIndex((r) => r.id === rowId);
    const j = direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i]!.sortOrder, list[j]!.sortOrder] = [list[j]!.sortOrder, list[i]!.sortOrder];
    list[i]!.version += 1;
    list[j]!.version += 1;
  };

  await page.route(
    (url) => url.pathname.includes("/price-list"),
    async (route) => {
      const req = route.request();
      const method = req.method();
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const path = new URL(req.url()).pathname;
      state.requests.push(`${method} ${path}`);
      const body = () => (req.postData() ? (req.postDataJSON() as Record<string, unknown>) : {});

      // Карточка туриста: только видимые позиции в видимых разделах, пустые разделы не приходят.
      if (path === `/places/${placeId}/price-list` && method === "GET")
        return json(route, {
          placeId,
          sections: dto()
            .sections.filter((s) => !s.hidden)
            .map((s) => ({
              id: s.id,
              title: s.title,
              items: s.items.filter((i) => !i.hidden).map(({ hidden: _h, sectionId: _s, ...rest }) => rest),
            }))
            .filter((s) => s.items.length),
        });

      const base = `/partner/places/${placeId}/price-list`;
      if (!path.startsWith(base)) return route.fallback();
      const sub = path.slice(base.length);
      if (sub === "" && method === "GET") return json(route, dto());
      if (sub === "/sections" && method === "POST") {
        const b = body() as { title: { uk: string } };
        state.sections.push({
          id: id(),
          title: b.title,
          hidden: false,
          sortOrder: state.sections.length,
          version: 1,
        });
        return json(route, dto(), 201);
      }
      if (sub === "/items" && method === "POST") {
        const b = body() as Omit<Item, "id" | "hidden" | "sortOrder" | "version" | "updatedAt" | "currency">;
        state.items.push({
          id: id(),
          sectionId: b.sectionId,
          name: b.name,
          description: b.description ?? null,
          priceMinor: b.priceMinor,
          currency: "UAH",
          priceFrom: b.priceFrom ?? false,
          unit: b.unit ?? null,
          hidden: false,
          sortOrder: state.items.filter((i) => i.sectionId === b.sectionId).length,
          version: 1,
          updatedAt: NOW,
        });
        return json(route, dto(), 201);
      }
      const m = /^\/(sections|items)\/([^/]+)(\/move|\/archive)?$/.exec(sub);
      if (!m) return json(route, { error: { code: "NOT_FOUND" } }, 404);
      const [, kind, rowId, action] = m;
      const rows: (Section | Item)[] = kind === "sections" ? state.sections : state.items;
      const row = rows.find((r) => r.id === rowId);
      if (!row) return json(route, { error: { code: "NOT_FOUND" } }, 404);
      if (action === "/move") {
        const direction = (body() as { direction: string }).direction;
        if (kind === "sections") swap(state.sections, rowId!, direction);
        else
          swap(
            state.items.filter((i) => i.sectionId === (row as Item).sectionId),
            rowId!,
            direction,
          );
        return json(route, dto());
      }
      if (action === "/archive") {
        if (kind === "sections") {
          state.sections = state.sections.filter((s) => s.id !== rowId);
          state.items = state.items.filter((i) => i.sectionId !== rowId);
        } else state.items = state.items.filter((i) => i.id !== rowId);
        return json(route, dto());
      }
      if (method === "PATCH") {
        const b = body() as Partial<Item & Section>;
        if (b.version !== undefined && b.version !== row.version)
          return json(
            route,
            { error: { code: "CONFLICT", messageKey: "errors.priceList.versionConflict" } },
            409,
          );
        const { version: _v, ...patch } = b;
        Object.assign(row, patch, { version: row.version + 1 });
        return json(route, dto());
      }
      return json(route, { error: { code: "NOT_FOUND" } }, 404);
    },
  );
  return state;
}
