// C04: раздел главной → корневая категория и её подкатегории, поиск по названию, список/карта.
// Порядок выдачи задаёт сервер (релевантность, реклама — по правилам C-02); клиент только помечает рекламу.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Stack, useT } from "@tg/ui";
import { useAsync, useGuide } from "./context.js";
import { MapSlot } from "./MapSlot.js";
import { AsyncView, PlaceList } from "./parts.js";
import type { CatalogSection, Category } from "./types.js";

const chip = (active: boolean) => ({
  font: "inherit",
  // Крупный жирный текст: активный чип — цвет фона на link_color (AA только как large text).
  fontSize: "1.2rem",
  fontWeight: 700,
  padding: "6px 12px",
  borderRadius: 999,
  border: "1px solid var(--color-link)",
  background: active ? "var(--color-link)" : "transparent",
  color: active ? "var(--color-bg)" : "var(--color-text)",
  cursor: "pointer",
});

export function Catalog({ section }: { section: CatalogSection }) {
  const { t } = useT();
  const { api } = useGuide();
  const [categories, retry] = useAsync(() => api.categories(), [api]);
  return (
    <Stack>
      <h1>{t(`miniapp.section.${section}` as MessageKey)}</h1>
      <AsyncView state={categories} retry={retry}>
        {(all) => {
          const root = all.find((c) => c.parentId === null && c.homeSection === section);
          if (!root) return <p data-testid="section-empty">{t("miniapp.catalog.sectionEmpty")}</p>;
          return <CategoryPlaces root={root} subcategories={all.filter((c) => c.parentId === root.id)} />;
        }}
      </AsyncView>
    </Stack>
  );
}

/** Сколько ждать базовую точку перед поиском без неё, мс. */
export const BASE_WAIT_MS = 4_000;

function CategoryPlaces({ root, subcategories }: { root: Category; subcategories: Category[] }) {
  const { t, locale } = useT();
  const { api, analytics, base } = useGuide();
  const [categoryId, setCategoryId] = useState(root.id);
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"list" | "map">("list");
  const point = base?.point ?? null;
  // Номер отправки формы поиска: search_used — один раз на ответ именно этой отправки (не при повторе,
  // смене категории/базовой точки или отменённой загрузке). Текст запроса не отправляется (ПДн-риск).
  const [submitId, setSubmitId] = useState(0);
  const pendingSubmit = useRef<number | null>(null);
  const [places, retry] = useAsync(
    () =>
      // Базовая точка ещё грузится — ждём её (пришла — эффект перезапустится с точкой), но не дольше
      // BASE_WAIT_MS: завис запрос точки — ищем без неё.
      (base?.pending ? new Promise((r) => setTimeout(r, BASE_WAIT_MS)) : Promise.resolve())
        .then(() => api.search({ categoryId, q: q || undefined, point }))
        .then((list) => ({ list, submitId })),
    [api, categoryId, q, submitId, base?.pending, point?.lat, point?.lng],
  );
  useEffect(() => {
    if (places.status !== "ready" || pendingSubmit.current !== places.data.submitId) return;
    pendingSubmit.current = null;
    if (q) analytics.track("search_used", { categoryId, resultCount: places.data.list.length });
  }, [analytics, categoryId, q, places]);

  useEffect(() => analytics.track("category_opened", { categoryId }), [analytics, categoryId]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // api принимает запрос от 2 символов; короче — показываем весь раздел.
    const text = draft.trim();
    setQ(text.length >= 2 ? text : "");
    pendingSubmit.current = submitId + 1;
    setSubmitId((n) => n + 1);
  };

  return (
    <Stack>
      {subcategories.length > 0 && (
        <div role="group" aria-label={t("miniapp.catalog.subcategories")}>
          <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {[root, ...subcategories].map((c) => (
              <button
                key={c.id}
                type="button"
                style={chip(c.id === categoryId)}
                aria-pressed={c.id === categoryId}
                onClick={() => setCategoryId(c.id)}
              >
                {c.id === root.id ? t("miniapp.catalog.all") : pickLocalized(c.name, locale)}
              </button>
            ))}
          </span>
        </div>
      )}
      <form role="search" onSubmit={submit} style={{ display: "flex", gap: 8 }}>
        <label htmlFor="catalog-q" style={{ position: "absolute", left: -9999 }}>
          {t("miniapp.catalog.searchLabel")}
        </label>
        <input
          id="catalog-q"
          type="search"
          value={draft}
          placeholder={t("miniapp.catalog.searchLabel")}
          onChange={(e) => setDraft(e.target.value)}
          style={{
            flex: 1,
            minWidth: 0,
            font: "inherit",
            padding: "8px 12px",
            borderRadius: "var(--radius)",
            border: "1px solid var(--color-hint)",
            background: "var(--color-bg)",
            color: "var(--color-text)",
          }}
        />
        <Button type="submit">{t("miniapp.catalog.searchButton")}</Button>
      </form>
      <div role="group" aria-label={t("miniapp.catalog.map")} style={{ display: "flex", gap: 6 }}>
        {(["list", "map"] as const).map((v) => (
          <button
            key={v}
            type="button"
            style={chip(view === v)}
            aria-pressed={view === v}
            onClick={() => setView(v)}
          >
            {t(`miniapp.catalog.${v}`)}
          </button>
        ))}
      </div>
      {/* Постоянная live-область: читалки объявляют изменение числа результатов. */}
      <p role="status" data-testid="catalog-count">
        {places.status === "ready" && places.data.list.length > 0
          ? t("miniapp.catalog.results", { count: places.data.list.length })
          : ""}
      </p>
      <AsyncView state={places} retry={retry}>
        {({ list }) =>
          list.length === 0 ? (
            <div>
              <p data-testid="catalog-empty">{t("miniapp.catalog.empty")}</p>
              {(q || categoryId !== root.id) && (
                <Button
                  onClick={() => {
                    setDraft("");
                    setQ("");
                    setCategoryId(root.id);
                  }}
                >
                  {t("miniapp.catalog.reset")}
                </Button>
              )}
            </div>
          ) : (
            <Stack>
              {view === "map" && <MapSlot places={list} center={point} centerLabel={base?.name} />}
              <PlaceList places={list} />
            </Stack>
          )
        }
      </AsyncView>
    </Stack>
  );
}
