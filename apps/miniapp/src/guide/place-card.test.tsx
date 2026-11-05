// Богатая картка місця: галерея с авторами фото и полноэкранным просмотром, тип и рейтинг Google, текст ШІ с
// пометкой, «Що пропонує», отзывы Google, Вікіпедія с лицензией фото, подписи источников. Нет данных — блоков нет.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ApiSchemas } from "@tg/api-client";
import type { Analytics } from "./analytics.js";
import { GuideProvider, type GuideEnv } from "./context.js";
import { cardOf, coverPhotoOf } from "./guide-api.js";
import { CoverCredit, PlaceMedia } from "./parts.js";
import { PlaceCard } from "./PlaceCard.js";
import type { GuideApi, PlaceDetail } from "./types.js";

afterEach(cleanup);

const P1 = "00000000-0000-4000-8000-000000000201";

const base: PlaceDetail = {
  descriptionAuto: true,
  id: P1,
  name: { uk: "Wood Stone" },
  categoryId: "c1",
  location: { lat: 48.48, lng: 24.59 },
  distanceMeters: null,
  cover: null,
  openNow: null,
  recommended: false,
  adLabel: null,
  description: { uk: "Ресторан у Яремчі. Джерело: Google Maps." },
  address: { uk: "вулиця Свободи, 59/3, Яремче" },
  phone: "+380983001120",
  website: "https://woodstone.example/",
  telegram: null,
  photos: [],
  schedule: [{ weekday: 1, opens: "10:00", closes: "22:00" }],
  tags: [],
  verifiedAt: null,
  openUntil: null,
  favorite: null,
};

const rich: Partial<PlaceDetail> = {
  typeLabel: "Ресторан",
  priceLevel: 2,
  rating: { value: 4.8, count: 792 },
  aiSummary: {
    text: "Ресторан у Яремчі з терасою. Відвідувачі хвалять краєвид.",
    model: "claude-sonnet-5-5",
  },
  summary: null,
  amenities: ["breakfast", "outdoor_seating", "kids_menu"],
  googlePhotos: [
    {
      url: "https://api.example/places/p/google-photos/0?w=400",
      largeUrl: "https://api.example/places/p/google-photos/0?w=1200",
      authors: [{ name: "Олена", uri: "https://maps.google.com/contrib/1", photoUri: null }],
    },
    {
      url: "https://api.example/places/p/google-photos/1?w=400",
      largeUrl: "https://api.example/places/p/google-photos/1?w=1200",
      authors: [{ name: "Тарас", uri: null, photoUri: null }],
    },
  ],
  reviews: [
    {
      author: { name: "Іван", uri: null, photoUri: "https://lh3.googleusercontent.com/a/1" },
      rating: 5,
      text: "Дуже смачно! ".repeat(30),
      relativeTime: "2 місяці тому",
      uri: "https://www.google.com/maps/reviews/1",
    },
  ],
  googleMapsUri: "https://maps.google.com/?cid=1",
  wikipedia: null,
};

function renderCard(place: PlaceDetail) {
  const env: GuideEnv = {
    api: { place: vi.fn(async () => place) } as unknown as GuideApi,
    analytics: {
      track: vi.fn(),
      flush: vi.fn(async () => undefined),
      dispose: vi.fn(),
    } as unknown as Analytics,
    base: null,
    regionId: "r",
    signedIn: false,
  };
  render(
    <GuideProvider value={env}>
      <PlaceCard id={P1} />
    </GuideProvider>,
  );
  return act(async () => new Promise((r) => setTimeout(r, 0)));
}

describe("графік: цілодобово", () => {
  const day = (weekday: number, opens: string, closes: string) => ({ weekday, opens, closes });
  const week = (opens: string, closes: string) => [1, 2, 3, 4, 5, 6, 7].map((d) => day(d, opens, closes));

  it("00:00–23:59 всі 7 днів — один рядок «Цілодобово» без таблиці", async () => {
    await renderCard({ ...base, schedule: week("00:00", "23:59") });
    expect(screen.getByText("Цілодобово")).toBeTruthy();
    expect(document.querySelector(".pc-schedule")).toBeNull();
  });

  it("00:00–24:00 всі 7 днів — теж «Цілодобово»", async () => {
    await renderCard({ ...base, schedule: week("00:00", "24:00") });
    expect(screen.getByText("Цілодобово")).toBeTruthy();
    expect(document.querySelector(".pc-schedule")).toBeNull();
  });

  it("частина днів — «цілодобово» лише в них, решта цифрами", async () => {
    await renderCard({ ...base, schedule: [day(1, "00:00", "23:59"), day(2, "10:00", "22:00")] });
    const rows = [...document.querySelectorAll(".pc-schedule tr")].map((r) => r.textContent);
    expect(rows[0]).toContain("Цілодобово");
    expect(rows[1]).toContain("10:00–22:00");
    expect(rows[2]).toContain("вихідний");
  });
});

describe("богатая картка місця", () => {
  it("тип, ціни, рейтинг Google, «Про місце» без пометки ШІ, «Що пропонує», відгуки, атрибуція Google", async () => {
    await renderCard({ ...base, ...rich });
    expect(screen.getByTestId("place-type").textContent).toBe("Ресторан · Середні ціни");
    expect(screen.getByTestId("place-rating").textContent).toContain("4.8");
    expect(screen.getByTestId("place-rating").textContent).toContain("Оцінок у Google: 792");
    const about = screen.getByTestId("place-about");
    expect(about.textContent).toContain("Ресторан у Яремчі з терасою");
    expect(screen.queryByTestId("place-ai-label")).toBeNull();
    expect(about.textContent).not.toContain("Згенеровано ШІ");
    expect(about.textContent).not.toContain("claude-sonnet-5-5");
    // Автоописание импорта при содержательном тексте не дублируется.
    expect(screen.queryByText("Ресторан у Яремчі. Джерело: Google Maps.")).toBeNull();
    const offers = within(screen.getByTestId("place-offers"));
    expect(offers.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Сніданки",
      "Тераса",
      "Дитяче меню",
    ]);
    const review = screen.getByTestId("place-review");
    expect(review.textContent).toContain("Іван");
    expect(review.textContent).toContain("2 місяці тому");
    expect(within(review).getByRole("link", { name: "Відгук у Google" }).getAttribute("href")).toBe(
      "https://www.google.com/maps/reviews/1",
    );
    const more = within(review).getByRole("button", { name: "Читати далі" });
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Усі відгуки в Google Maps" })).toBeDefined();
    expect(screen.getByTestId("place-google-attribution").textContent).toBe(
      "Дані, фото й відгуки: Google Maps",
    );
  });

  it("галерея: подпись автора со ссылкой, счётчик, полноэкранный просмотр 1200 px, Escape закрывает", async () => {
    await renderCard({ ...base, ...rich });
    const gallery = screen.getByTestId("place-photos");
    expect(within(gallery).getByRole("link", { name: "Олена" }).getAttribute("href")).toBe(
      "https://maps.google.com/contrib/1",
    );
    fireEvent.click(within(gallery).getByRole("button", { name: "Відкрити фото 2 з 2" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
      "https://api.example/places/p/google-photos/1?w=1200",
    );
    expect(dialog.textContent).toContain("Тарас");
    fireEvent.click(within(dialog).getByRole("button", { name: "Наступне фото" }));
    expect(dialog.textContent).toContain("Олена");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("фото не загрузилось — убирается из галереи", async () => {
    await renderCard({ ...base, ...rich });
    const imgs = screen.getByTestId("place-photos").querySelectorAll("img");
    fireEvent.error(imgs[0]!);
    expect(screen.getByTestId("place-photos").querySelectorAll("img")).toHaveLength(1);
  });

  it("Вікіпедія: ссылка на статью, автор и лицензия фото Commons; текста статьи нет (CC BY-SA)", async () => {
    await renderCard({
      ...base,
      ...rich,
      aiSummary: null,
      // Текст статьи в данных карточки (как от старого api) всё равно не показывается.
      wikipedia: {
        title: "Пробій (водоспад)",
        url: "https://uk.m.wikipedia.org/wiki/Пробій",
        extract: "Пробій — водоспад на річці Прут.",
        image: {
          url: "https://upload.wikimedia.org/x.jpg",
          author: "MSha",
          license: "CC BY-SA 3.0",
          sourceUrl: "https://commons.wikimedia.org/wiki/File:Probij-5.JPG",
        },
      } as never,
    });
    const wiki = screen.getByTestId("place-wikipedia");
    expect(within(wiki).getByRole("link", { name: "Читати у Вікіпедії" }).getAttribute("href")).toBe(
      "https://uk.m.wikipedia.org/wiki/Пробій",
    );
    expect(within(wiki).getByRole("link", { name: /MSha · CC BY-SA 3.0 · Wikimedia Commons/ })).toBeDefined();
    expect(wiki.textContent).toContain("Джерело: Вікіпедія");
    expect(document.body.textContent).not.toContain("Пробій — водоспад на річці Прут.");
  });

  it("статья есть, пересказа ещё нет — автоописание остаётся: карточка не пустая", async () => {
    await renderCard({
      ...base,
      aiSummary: null,
      wikipedia: { title: "Пробій", url: "https://uk.m.wikipedia.org/wiki/Пробій", image: null },
    });
    expect(screen.getByText("Ресторан у Яремчі. Джерело: Google Maps.")).toBeDefined();
  });

  it("нет данных Google/Вікіпедії/ШІ — блоков нет, только описание и график (ничего не выдумываем)", async () => {
    await renderCard(base);
    for (const id of [
      "place-photos",
      "place-type",
      "place-rating",
      "place-about",
      "place-ai-label",
      "place-offers",
      "place-reviews",
      "place-wikipedia",
      "place-google-attribution",
    ])
      expect(screen.queryByTestId(id), id).toBeNull();
    expect(screen.getByText("Ресторан у Яремчі. Джерело: Google Maps.")).toBeDefined();
  });
});

describe("картка: устойчивость и описание", () => {
  it("лайтбокс открыт на последнем фото, фото пропало из галереи — индекс зажимается, без ошибки", async () => {
    await renderCard({ ...base, ...rich });
    fireEvent.click(screen.getByRole("button", { name: "Відкрити фото 2 з 2" }));
    const thumbs = screen.getByTestId("place-photos").querySelectorAll("img");
    fireEvent.error(thumbs[1]!);
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
      "https://api.example/places/p/google-photos/0?w=1200",
    );
    expect(dialog.textContent).toContain("1 / 1");
  });

  it("большое фото не загрузилось — превью; не загрузилось и оно — лайтбокс закрывается, фокус на кнопке фото", async () => {
    await renderCard({ ...base, ...rich });
    const opener = screen.getByRole("button", { name: "Відкрити фото 1 з 2" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.body.style.overflow).toBe("hidden");
    const img = () => screen.getByRole("dialog").querySelector("img")!;
    fireEvent.error(img());
    expect(img().getAttribute("src")).toBe("https://api.example/places/p/google-photos/0?w=400");
    fireEvent.error(img());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Відкрити фото 1 з 2" }));
  });

  it("«Назад» Telegram при открытом фото закрывает фото, а не уходит с экрана", async () => {
    const { consumeBack } = await import("../telegram.js");
    await renderCard({ ...base, ...rich });
    expect(consumeBack()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Відкрити фото 1 з 2" }));
    act(() => {
      expect(consumeBack()).toBe(true);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(consumeBack()).toBe(false);
  });

  it("ручное описание (не автоописание импорта) остаётся рядом с текстом ШІ", async () => {
    await renderCard({ ...base, ...rich, descriptionAuto: false, description: { uk: "Опис від власника." } });
    expect(screen.getByText("Опис від власника.")).toBeDefined();
    expect(screen.getByTestId("place-about")).toBeDefined();
  });

  it("удобства по отзывам Google — отдельные чипы с пометкой «за відгуками Google»; без них пометки нет", async () => {
    await renderCard({
      ...base,
      tags: [{ uk: "З дітьми" }],
      reviewTags: [{ uk: "Басейн" }, { uk: "Чан / джакузі" }],
    });
    const box = screen.getByTestId("place-review-tags");
    expect(box.textContent).toContain("Басейн");
    expect(box.textContent).toContain("Чан / джакузі");
    expect(box.textContent).toContain("за відгуками Google");
    expect(box.textContent).not.toContain("З дітьми");
    cleanup();
    await renderCard({ ...base, tags: [{ uk: "З дітьми" }] });
    expect(screen.queryByTestId("place-review-tags")).toBeNull();
    expect(screen.getByText("З дітьми")).toBeDefined();
  });

  it("атрибуция Google — и при одном лишь типе места от Google", async () => {
    await renderCard({ ...base, typeLabel: "Ресторан" });
    expect(screen.getByTestId("place-google-attribution")).toBeDefined();
  });
});

type CardDto = ApiSchemas["PlaceCardDto"];
const dto = {
  id: P1,
  regionId: "r",
  categoryId: "c1",
  category: { id: "c1", parentId: null, name: { uk: "Ресторани" }, icon: null },
  name: { uk: "Wood Stone" },
  address: null,
  location: { lon: 24.59, lat: 48.48 },
  distanceMeters: null,
  recommended: false,
  adLabel: null,
  openNow: null,
  phone: null,
  cover: null,
  coverPhoto: null,
  description: null,
  website: null,
  telegram: null,
  verifiedAt: null,
  photos: [],
  tags: [],
  schedule: { timezone: "Europe/Kyiv", weekly: [], exceptions: [] },
  openUntil: null,
  favorite: null,
};

describe("обложка у нас (Google/Wikimedia)", () => {
  const cover = {
    url: "https://api.example/places/p/cover?regionId=r&v=abc",
    alt: null,
    credit: {
      authors: [{ name: "Олена", uri: "https://maps.google.com/contrib/1", photoUri: null }],
      license: null,
      sourceUrl: null,
      source: "google" as const,
    },
  };

  it("галерея Google недоступна (предел) — в карточке обложка с подписью автора", async () => {
    await renderCard({ ...base, cover, googlePhotos: [] });
    const gallery = screen.getByTestId("place-photos");
    expect(gallery.querySelector("img")?.getAttribute("src")).toBe(cover.url);
    expect(within(gallery).getByRole("link", { name: "Олена" })).toBeDefined();
  });

  it("cardOf: текст статьи от старого api в карточку не попадает", () => {
    const card = cardOf({
      ...dto,
      wikipedia: {
        lang: "uk",
        title: "Пробій",
        url: "https://uk.m.wikipedia.org/wiki/Пробій",
        extract: "Пробій — водоспад на річці Прут.",
        truncated: true,
        image: null,
      },
    } as unknown as CardDto);
    expect(card.wikipedia).toEqual({
      title: "Пробій",
      url: "https://uk.m.wikipedia.org/wiki/Пробій",
      image: null,
    });
  });

  it("галерея: обложка Wikimedia — автор, лицензия и ссылка на файл", async () => {
    const sourceUrl = "https://commons.wikimedia.org/wiki/File:X.jpg";
    await renderCard({
      ...base,
      googlePhotos: [],
      cover: {
        url: cover.url,
        alt: null,
        credit: {
          authors: [{ name: "MSha", uri: sourceUrl, photoUri: null }],
          license: "CC BY-SA 3.0",
          sourceUrl,
          source: "wikimedia" as const,
        },
      },
    });
    const gallery = screen.getByTestId("place-photos");
    expect(within(gallery).getByRole("link", { name: "MSha" })).toBeDefined();
    expect(within(gallery).getByRole("link", { name: "CC BY-SA 3.0" }).getAttribute("href")).toBe(sourceUrl);
  });

  it("нет обложки и фото — без галереи", async () => {
    await renderCard({ ...base, cover: null, googlePhotos: [] });
    expect(screen.queryByTestId("place-photos")).toBeNull();
  });

  it("cardOf/summaryOf: coverPhoto → cover с подписью; Wikimedia — автор и лицензия", () => {
    const card = cardOf({
      ...dto,
      coverPhoto: {
        url: "https://api.example/places/p/cover?regionId=r&v=1",
        width: 400,
        height: 300,
        source: "wikimedia",
        authors: [{ name: "MSha", uri: null, photoUri: null }],
        license: "CC BY-SA 3.0",
        sourceUrl: "https://commons.wikimedia.org/wiki/File:X.jpg",
      },
    } as unknown as CardDto);
    expect(card.cover).toMatchObject({
      url: "https://api.example/places/p/cover?regionId=r&v=1",
      credit: { source: "wikimedia", license: "CC BY-SA 3.0", authors: [{ name: "MSha" }] },
    });
  });
});

describe("обложка в списках", () => {
  const google = {
    authors: [{ name: "Олена", uri: null, photoUri: null }],
    license: null,
    sourceUrl: null,
    source: "google" as const,
  };

  it("coverPhotoOf: свой путь — да, protocol-relative //host — нет", () => {
    const cov = (url: string) => ({ url, width: 400, height: 300, ...google });
    expect(coverPhotoOf(cov("/places/p/cover?v=1") as never)?.url).toBe("/places/p/cover?v=1");
    expect(coverPhotoOf(cov("//evil.example/x.webp") as never)).toBeNull();
    expect(coverPhotoOf(cov("/\\evil.example/x.webp") as never)).toBeNull();
    expect(coverPhotoOf(cov("/\t/evil.example/x") as never)).toBeNull();
    expect(coverPhotoOf(cov("/places/p\n/cover") as never)).toBeNull();
  });

  it("подпись Google-обложки — «Дані: Google Maps»", () => {
    render(<CoverCredit credit={google} />);
    expect(screen.getByTestId("cover-credit").textContent).toBe("Фото: Олена · Дані: Google Maps");
    cleanup();
    render(<CoverCredit credit={{ ...google, authors: [] }} />);
    expect(screen.getByTestId("cover-credit").textContent).toBe("Дані: Google Maps");
  });

  it("подпись обложки Wikimedia в списке — автор, лицензия и ссылка на страницу файла", () => {
    const sourceUrl = "https://commons.wikimedia.org/wiki/File:X.jpg";
    render(
      <CoverCredit
        credit={{
          authors: [{ name: "MSha", uri: sourceUrl, photoUri: null }],
          license: "CC BY-SA 3.0",
          sourceUrl,
          source: "wikimedia",
        }}
      />,
    );
    const link = within(screen.getByTestId("cover-credit")).getByRole("link");
    expect(link.getAttribute("href")).toBe(sourceUrl);
    expect(link.textContent).toBe("Фото: MSha · CC BY-SA 3.0 · Wikimedia Commons");
    cleanup();
  });

  it("файл обложки не загрузился — подложка вместо битой картинки", () => {
    const { container } = render(
      <PlaceMedia place={{ ...base, cover: { url: "https://api.example/c", alt: null, credit: google } }} />,
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByTestId("cover-credit")).toBeNull();
  });
});

describe("cardOf — богатые поля", () => {
  it("старый api без полей — пусто; небезопасные ссылки отбрасываются", () => {
    expect(cardOf(dto as unknown as CardDto)).toMatchObject({
      amenities: [],
      reviews: [],
      googlePhotos: [],
      rating: null,
      wikipedia: null,
      aiSummary: null,
    });
    const card = cardOf({
      ...dto,
      descriptionAuto: false,
      typeLabel: "Ресторан",
      summary: null,
      aiSummary: null,
      priceLevel: null,
      amenities: [],
      rating: { value: 4.8, count: 10, source: "google" },
      reviews: [
        {
          author: { name: "X", uri: "javascript:alert(1)", photoUri: "data:image/png;base64,AAA" },
          rating: 5,
          text: "ok",
          language: "uk",
          publishTime: null,
          relativeTime: null,
          uri: "javascript:alert(2)",
        },
      ],
      googlePhotos: [
        { url: "javascript:x", largeUrl: "javascript:y", width: null, height: null, authors: [] },
      ],
      googleMapsUri: "http://maps.google.com",
      wikipedia: null,
      peak: null,
    } as CardDto);
    expect(card.reviews![0]!.author).toEqual({ name: "X", uri: null, photoUri: null });
    expect(card.reviews![0]!.uri).toBeNull();
    expect(card.googlePhotos).toEqual([]);
    expect(card.googleMapsUri).toBeNull();
    expect(card.rating).toEqual({ value: 4.8, count: 10 });
  });
});
