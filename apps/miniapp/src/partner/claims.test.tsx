// «Це мій заклад» (0031): ссылка в карточке места (флаг, сессия, место без организации), форма заявки (телефон из
// Telegram, новая или своя организация, ошибки сервера), статус заявки в кабинете с комментарием модератора.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { FeatureFlagsProvider, I18nProvider } from "@tg/ui";
import type { Analytics } from "../guide/analytics.js";
import { GuideProvider, type GuideEnv } from "../guide/context.js";
import { PlaceCard } from "../guide/PlaceCard.js";
import type { GuideApi, PlaceDetail } from "../guide/types.js";
import { ApiCallError } from "../host/types.js";
import type { TelegramWebApp } from "../telegram.js";
import { ClaimPlace } from "./ClaimPlace.js";
import { MyClaims } from "./ClaimsList.js";
import { noopPartnerApi, PartnerProvider } from "./context.js";
import type { PartnerApi, PartnerMe, PlaceClaim } from "./partner-api.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const PLACE = "00000000-0000-4000-8000-000000000201";
const ORG = "00000000-0000-4000-8000-00000000a001";

const place: PlaceDetail = {
  id: PLACE,
  name: { uk: "Wood Stone" },
  categoryId: "c1",
  location: { lat: 48.48, lng: 24.59 },
  distanceMeters: null,
  cover: null,
  openNow: null,
  recommended: false,
  adLabel: null,
  description: null,
  address: { uk: "Яремче" },
  phone: "+380983001120",
  website: null,
  telegram: null,
  photos: [],
  schedule: [],
  tags: [],
  verifiedAt: null,
  openUntil: null,
  favorite: null,
  claimable: true,
};

const claim = (over: Partial<PlaceClaim> = {}): PlaceClaim => ({
  id: "00000000-0000-4000-8000-00000000f001",
  regionId: "r1",
  placeId: PLACE,
  placeName: { uk: "Wood Stone" },
  role: "owner",
  status: "pending",
  organizationId: null,
  organizationName: "ФОП Гуцул",
  decisionComment: null,
  createdAt: "2026-11-05T10:00:00Z",
  decidedAt: null,
  ...over,
});

const noOrgs: PartnerMe = { organizations: [] };

function setup(
  ui: ReactNode,
  opts: {
    api?: Partial<PartnerApi>;
    detail?: PlaceDetail;
    signedIn?: boolean;
    flag?: boolean;
    webApp?: TelegramWebApp;
  } = {},
) {
  const api = { me: () => Promise.resolve(noOrgs), ...opts.api };
  const merged = new Proxy({ ...noopPartnerApi(), ...api } as PartnerApi, {
    get: (_t, key: string) =>
      (api as Record<string, unknown>)[key] ?? (() => Promise.reject(new Error("no api"))),
  });
  const env: GuideEnv = {
    api: { place: vi.fn(async () => opts.detail ?? place) } as unknown as GuideApi,
    analytics: {
      track: vi.fn(),
      flush: vi.fn(async () => undefined),
      dispose: vi.fn(),
    } as unknown as Analytics,
    base: null,
    regionId: "r1",
    signedIn: opts.signedIn ?? true,
    webApp: opts.webApp,
  };
  render(
    <I18nProvider locale="uk">
      <FeatureFlagsProvider flags={{ "module.partner_cabinet": opts.flag ?? true }}>
        <GuideProvider value={env}>
          <PartnerProvider api={merged} regionId="r1" enabled={opts.signedIn ?? true}>
            {ui}
          </PartnerProvider>
        </GuideProvider>
      </FeatureFlagsProvider>
    </I18nProvider>,
  );
  return act(async () => new Promise((r) => setTimeout(r, 0)));
}

describe("карточка места: «Це мій заклад?»", () => {
  it("место без организации, модуль включён, есть сессия — ссылка на форму заявки", async () => {
    await setup(<PlaceCard id={PLACE} />);
    const link = screen.getByTestId("place-claim");
    expect(link.textContent).toBe("Це мій заклад?");
    expect(link.getAttribute("href")).toBe(`#/partner/claim/${PLACE}`);
  });

  it("нет ссылки: место уже с организацией, без сессии или модуль выключен", async () => {
    await setup(<PlaceCard id={PLACE} />, { detail: { ...place, claimable: false } });
    expect(screen.queryByTestId("place-claim")).toBeNull();
    cleanup();
    await setup(<PlaceCard id={PLACE} />, { signedIn: false });
    expect(screen.queryByTestId("place-claim")).toBeNull();
    cleanup();
    await setup(<PlaceCard id={PLACE} />, { flag: false });
    expect(screen.queryByTestId("place-claim")).toBeNull();
  });
});

describe("форма заявки", () => {
  it("телефон из Telegram, новая организация (по умолчанию — название места) → заявка на розгляді", async () => {
    const createClaim = vi.fn(async () => claim());
    const webApp = {
      requestContact: (cb: (sent: boolean, res?: unknown) => void) =>
        cb(true, { responseUnsafe: { contact: { phone_number: "380671112233" } } }),
    } as unknown as TelegramWebApp;
    await setup(<ClaimPlace placeId={PLACE} />, {
      api: { claims: async () => [], createClaim },
      webApp,
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Це мій заклад");
    expect((screen.getByLabelText("Назва організації") as HTMLInputElement).value).toBe("Wood Stone");
    fireEvent.click(screen.getByLabelText("Керуючий"));
    fireEvent.click(screen.getByTestId("claim-share-contact"));
    expect((screen.getByLabelText("Ваш телефон для зв'язку") as HTMLInputElement).value).toBe(
      "+380671112233",
    );
    fireEvent.change(screen.getByLabelText("Коментар модератору (необов'язково)"), {
      target: { value: "  Дзвоніть після 18:00 " },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("claim-submit"));
    });
    expect(createClaim).toHaveBeenCalledWith(
      {
        regionId: "r1",
        placeId: PLACE,
        role: "manager",
        phone: "+380671112233",
        phoneSource: "telegram_contact",
        comment: "Дзвоніть після 18:00",
        organizationName: "Wood Stone",
      },
      expect.any(String),
    );
    expect(screen.getByTestId("claim-pending").textContent).toContain("На перевірці");
    expect(screen.getByRole("link", { name: "До розділу «Мій заклад»" })).toBeTruthy();
  });

  it("своя организация (ORG_OWNER) — organizationId; неверный телефон — подсказка, без запроса", async () => {
    const createClaim = vi.fn(async () => claim({ organizationId: ORG }));
    const me: PartnerMe = {
      organizations: [
        {
          id: ORG,
          regionId: "r1",
          name: "ТОВ Смерека",
          role: "ORG_OWNER",
          assignmentId: "a1",
          abilities: {} as PartnerMe["organizations"][number]["abilities"],
          places: [],
        },
      ],
    };
    await setup(<ClaimPlace placeId={PLACE} />, {
      api: { me: async () => me, claims: async () => [], createClaim },
    });
    fireEvent.change(screen.getByLabelText("Ваш телефон для зв'язку"), { target: { value: "123" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("claim-submit"));
    });
    expect(createClaim).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Вкажіть номер у форматі +380XXXXXXXXX.");
    fireEvent.click(screen.getByLabelText("ТОВ Смерека"));
    expect(screen.queryByLabelText("Назва організації")).toBeNull();
    fireEvent.change(screen.getByLabelText("Ваш телефон для зв'язку"), { target: { value: "0501112233" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("claim-submit"));
    });
    expect(createClaim).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, phone: "+380501112233", phoneSource: "manual" }),
      expect.any(String),
    );
  });

  it("409 сервера — понятный текст; уже есть заявка на рассмотрении — статус вместо формы", async () => {
    const createClaim = vi.fn(async () => {
      throw new ApiCallError(409, "errors.placeClaim.alreadyClaimed", "CONFLICT");
    });
    await setup(<ClaimPlace placeId={PLACE} />, { api: { claims: async () => [], createClaim } });
    fireEvent.change(screen.getByLabelText("Ваш телефон для зв'язку"), {
      target: { value: "+380501112233" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("claim-submit"));
    });
    expect(screen.getByRole("alert").textContent).toBe("Цей заклад уже закріплено за організацією.");
    cleanup();
    await setup(<ClaimPlace placeId={PLACE} />, { api: { claims: async () => [claim()] } });
    expect(screen.getByTestId("claim-pending").textContent).toContain(
      "Ваша заявка на цей заклад уже на розгляді.",
    );
    expect(screen.queryByTestId("claim-submit")).toBeNull();
  });
});

describe("кабинет: мои заявки", () => {
  it("статусы и комментарий модератора; пусто — блока нет", async () => {
    await setup(<MyClaims />, {
      api: {
        claims: async () => [
          claim(),
          claim({
            id: "00000000-0000-4000-8000-00000000f002",
            status: "rejected",
            decisionComment: "Не вдалося підтвердити",
          }),
        ],
      },
    });
    const items = screen.getAllByTestId("my-claim");
    expect(items.map((i) => i.querySelector("[data-testid=claim-status]")?.textContent)).toEqual([
      "На перевірці",
      "Не прийнято",
    ]);
    expect(screen.getByTestId("claim-comment").textContent).toBe(
      "Коментар модератора: Не вдалося підтвердити",
    );
    cleanup();
    await setup(<MyClaims />, { api: { claims: async () => [] } });
    expect(screen.queryByTestId("my-claims")).toBeNull();
  });
});
