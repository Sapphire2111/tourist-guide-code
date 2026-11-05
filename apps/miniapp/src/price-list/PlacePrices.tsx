// «Ціни» в карточке места: прайс заведения партнёра (миграция 0030) — только чтение, без заказа и оплаты. Блок
// есть, только если у места есть видимые позиции; ошибка загрузки — блока нет (цены не обязательны для карточки).
// Свернуто до PRICES_COLLAPSED позиций с «Показати все».
import { useId, useState } from "react";
import { pickLocalized } from "@tg/i18n";
import { useT } from "@tg/ui";
import { useAsync, useGuide } from "../guide/context.js";
import type { GuideApi, PriceListView } from "../guide/types.js";
import { priceText } from "./price.js";
import "../guide/place-card.css";
import "./price-list.css";

/** Сколько позиций видно до «Показати все». */
export const PRICES_COLLAPSED = 6;

/** Разделы с первыми limit позициями по порядку (разделы без показанных позиций — без заголовка). */
export function firstItems(sections: PriceListView["sections"], limit: number): PriceListView["sections"] {
  let left = limit;
  const out: PriceListView["sections"] = [];
  for (const s of sections) {
    if (left <= 0) break;
    const items = s.items.slice(0, left);
    left -= items.length;
    if (items.length) out.push({ ...s, items });
  }
  return out;
}

export function PlacePrices({ placeId }: { placeId: string }) {
  const { api } = useGuide();
  if (!api.priceList) return null;
  return <Prices placeId={placeId} api={api} />;
}

function Prices({ placeId, api }: { placeId: string; api: GuideApi }) {
  const { t, locale } = useT();
  const [state] = useAsync(
    () => api.priceList?.(placeId) ?? Promise.resolve({ sections: [] }),
    [api, placeId],
  );
  const [all, setAll] = useState(false);
  const listId = useId();
  const headingId = useId();
  if (state.status !== "ready") return null;
  const sections = state.data.sections.filter((s) => s.items.length);
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  if (!total) return null;
  const shown = all ? sections : firstItems(sections, PRICES_COLLAPSED);
  const titled = sections.length > 1;
  return (
    <section className="pc-section" aria-labelledby={headingId} data-testid="place-prices">
      <header className="pc-section-head">
        <h2 className="pc-h2" id={headingId}>
          {t("miniapp.place.prices")}
        </h2>
      </header>
      <div id={listId} className="pl-card">
        {shown.map((s) => (
          <div key={s.id} className="pl-card-section">
            {titled && <h3 className="pl-card-title">{pickLocalized(s.title, locale)}</h3>}
            <ul className="pl-card-list">
              {s.items.map((i) => {
                const unit = i.unit ? pickLocalized(i.unit, locale) : null;
                return (
                  <li key={i.id} className="pl-card-row" data-testid="place-price">
                    <span className="pl-card-name">
                      {pickLocalized(i.name, locale)}
                      {i.description && (
                        <small className="pl-card-desc">{pickLocalized(i.description, locale)}</small>
                      )}
                    </span>
                    <span className="pl-card-price">{priceText(t, locale, i, unit)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      {total > PRICES_COLLAPSED && (
        <button
          type="button"
          className="pl-more"
          aria-expanded={all}
          aria-controls={listId}
          onClick={() => setAll((x) => !x)}
          data-testid="place-prices-more"
        >
          {all ? t("miniapp.place.pricesShowLess") : t("miniapp.place.pricesShowAll", { count: total })}
        </button>
      )}
      <p className="pc-source">{t("miniapp.place.pricesNote")}</p>
    </section>
  );
}
