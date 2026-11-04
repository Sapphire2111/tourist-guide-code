// Блок 10, интерфейс отзывов: рейтинг D-37 и список в карточке (скрыт без флага), жалоба, «Залишити відгук» только
// по праву, форма (валидация, автофильтр → модерация, ошибки сервера), «Мої бронювання», кабинет партнёра (ответ,
// автофильтр ответа, жалоба, апелляция).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { FeatureFlagsProvider, I18nProvider } from "@tg/ui";
import { noopAnalytics } from "../guide/analytics.js";
import { GuideProvider, type GuideEnv } from "../guide/context.js";
import type { GuideApi } from "../guide/types.js";
import { ApiCallError, ConflictError, NetworkError } from "../host/types.js";
import { BookingReview } from "./BookingReview.js";
import { ReviewsProvider } from "./context.js";
import { PartnerReviews } from "./PartnerReviews.js";
import { PlaceReviews } from "./PlaceReviews.js";
import { ReviewScreen } from "./ReviewScreens.js";
import type {
  MyReview,
  PartnerReview,
  PlaceReviews as PlaceReviewsData,
  PublicReview,
  ReviewEligibility,
  ReviewsApi,
} from "./reviews-api.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const REGION = "00000000-0000-4000-8000-0000000000a1";
const PLACE = "00000000-0000-4000-8000-000000000201";
const ELIG = "00000000-0000-4000-8000-000000000501";
const BOOKING = "00000000-0000-4000-8000-000000000401";
const REVIEW = "00000000-0000-4000-8000-000000000601";
const FUTURE = new Date(Date.now() + 10 * 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

const publicReview = (over: Partial<PublicReview> = {}): PublicReview => ({
  id: REVIEW,
  placeId: PLACE,
  rating: 4,
  text: "Чудове місце, смачна кава.",
  version: 1,
  verificationLevel: "verified_booking",
  authorName: "Олена",
  publishedAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  response: null,
  ...over,
});

const ratings = (over: Partial<PlaceReviewsData["rating"]> = {}): PlaceReviewsData["rating"] => ({
  placeId: PLACE,
  reviewCount: 5,
  fewReviews: false,
  score: 4.3,
  minReviews: 3,
  ...over,
});

const myReview = (over: Partial<MyReview> = {}): MyReview => ({
  id: REVIEW,
  placeId: PLACE,
  status: "published",
  rating: 5,
  text: "Було чудово",
  version: 1,
  autoFlags: [],
  hiddenReason: null,
  publishedAt: "2026-10-01T10:00:00.000Z",
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  response: null,
  appeal: null,
  canAppeal: false,
  ...over,
});

const eligibility = (over: Partial<ReviewEligibility> = {}): ReviewEligibility => ({
  id: ELIG,
  placeId: PLACE,
  placeName: { uk: "Садиба «Смерека»" },
  bookingId: BOOKING,
  level: "verified_booking",
  status: "active",
  issuedAt: PAST,
  expiresAt: FUTURE,
  review: null,
  ...over,
});

const partnerReview = (over: Partial<PartnerReview> = {}): PartnerReview => ({
  id: REVIEW,
  regionId: REGION,
  placeId: PLACE,
  placeName: { uk: "Садиба «Смерека»" },
  status: "published",
  rating: 2,
  text: "Довго чекали",
  version: 1,
  authorName: "Іван",
  publishedAt: "2026-10-02T10:00:00.000Z",
  createdAt: "2026-10-02T10:00:00.000Z",
  updatedAt: "2026-10-02T10:00:00.000Z",
  response: null,
  myComplaints: [],
  appeal: null,
  canRespond: true,
  canAppeal: false,
  ...over,
});

function fakeApi(over: Partial<ReviewsApi> = {}): ReviewsApi {
  return {
    placeReviews: vi.fn(async () => ({ rating: ratings(), items: [publicReview()] })),
    eligibility: vi.fn(async () => []),
    submit: vi.fn(async () => myReview()),
    complain: vi.fn(async (_r, id) => ({
      id: "c1",
      reviewId: id,
      kind: "user" as const,
      reasonCode: "insult" as const,
      text: null,
      status: "open" as const,
      createdAt: PAST,
      decidedAt: null,
    })),
    appeal: vi.fn(async (_r, id, text) => ({
      id: "a1",
      reviewId: id,
      kind: "author" as const,
      text,
      status: "open" as const,
      decisionNote: null,
      createdAt: PAST,
      decidedAt: null,
    })),
    partnerReviews: vi.fn(async () => [partnerReview()]),
    respond: vi.fn(async (_id, text) => ({
      id: "r1",
      text,
      version: 1,
      createdAt: PAST,
      updatedAt: PAST,
    })),
    ...over,
  };
}

function renderWith(
  ui: ReactNode,
  {
    api = fakeApi(),
    flag = true,
    signedIn = true,
  }: { api?: ReviewsApi; flag?: boolean; signedIn?: boolean } = {},
) {
  const guide: GuideEnv = {
    api: {} as GuideApi,
    analytics: noopAnalytics,
    webApp: undefined,
    base: null,
    regionId: REGION,
    signedIn,
  };
  render(
    <I18nProvider locale="uk">
      <FeatureFlagsProvider flags={{ "module.reviews": flag }}>
        <GuideProvider value={guide}>
          <ReviewsProvider value={{ api }}>{ui}</ReviewsProvider>
        </GuideProvider>
      </FeatureFlagsProvider>
    </I18nProvider>,
  );
  return api;
}

describe("карточка місця: відгуки гостей", () => {
  it("флаг выключен — блока нет и запросов нет", () => {
    const api = renderWith(<PlaceReviews placeId={PLACE} />, { flag: false });
    expect(screen.queryByTestId("place-guest-reviews")).toBeNull();
    expect(api.placeReviews).not.toHaveBeenCalled();
    expect(api.eligibility).not.toHaveBeenCalled();
  });

  it("рейтинг и список с ответом заведения", async () => {
    renderWith(<PlaceReviews placeId={PLACE} />, {
      api: fakeApi({
        placeReviews: vi.fn(async () => ({
          rating: ratings(),
          items: [
            publicReview({
              response: { id: "r", text: "Дякуємо!", version: 1, createdAt: PAST, updatedAt: PAST },
            }),
          ],
        })),
      }),
    });
    expect((await screen.findByTestId("reviews-rating")).textContent).toContain("4.3");
    expect(screen.getByTestId("reviews-rating").textContent).toContain("Підтверджених відгуків: 5");
    const item = screen.getByTestId("guest-review");
    expect(item.textContent).toContain("Олена");
    expect(item.textContent).toContain("Підтверджене відвідування");
    expect(within(item).getByTestId("review-response").textContent).toContain("Дякуємо!");
  });

  it("мало отзывов — «Мало відгуків» вместо цифры", async () => {
    renderWith(<PlaceReviews placeId={PLACE} />, {
      api: fakeApi({
        placeReviews: vi.fn(async () => ({
          rating: ratings({ fewReviews: true, score: null, reviewCount: 2 }),
          items: [publicReview()],
        })),
      }),
    });
    const rating = await screen.findByTestId("reviews-rating");
    expect(rating.textContent).toContain("Мало відгуків");
    expect(rating.textContent).not.toMatch(/\d\.\d/);
  });

  it("нет отзывов — «Відгуків ще немає»; ошибка — с повтором", async () => {
    const placeReviews = vi
      .fn<ReviewsApi["placeReviews"]>()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValue({ rating: ratings({ reviewCount: 0, fewReviews: true, score: null }), items: [] });
    renderWith(<PlaceReviews placeId={PLACE} />, { api: fakeApi({ placeReviews }) });
    expect((await screen.findByRole("alert")).textContent).toContain("Не вдалося завантажити відгуки");
    fireEvent.click(screen.getByRole("button", { name: "Спробувати ще раз" }));
    expect((await screen.findByTestId("reviews-empty")).textContent).toBe("Відгуків ще немає");
  });

  it("жалоба: причина и текст уходят в API, отзыв остаётся, показано сообщение", async () => {
    const api = renderWith(<PlaceReviews placeId={PLACE} />);
    fireEvent.click(await screen.findByTestId("complain-open"));
    fireEvent.change(screen.getByLabelText("Причина"), { target: { value: "spam" } });
    fireEvent.change(screen.getByLabelText("Подробиці (необов’язково)"), { target: { value: " реклама " } });
    fireEvent.click(screen.getByTestId("complaint-send"));
    await screen.findByText(/Скаргу надіслано/);
    expect(api.complain).toHaveBeenCalledWith(REGION, REVIEW, { reasonCode: "spam", text: "реклама" });
    expect(screen.getByTestId("guest-review")).toBeTruthy();
  });

  it("жалоба: повторная (409) — понятная ошибка, форма остаётся", async () => {
    renderWith(<PlaceReviews placeId={PLACE} />, {
      api: fakeApi({
        complain: vi.fn(async () => {
          throw new ConflictError("errors.review.complaintExists", "COMPLAINT_EXISTS", null);
        }),
      }),
    });
    fireEvent.click(await screen.findByTestId("complain-open"));
    fireEvent.click(screen.getByTestId("complaint-send"));
    await waitFor(() =>
      expect(screen.getByTestId("complaint-error").textContent).toContain("вже скаржилися"),
    );
  });

  it("без входа «Поскаржитися» и «Залишити відгук» не показываются", async () => {
    const api = renderWith(<PlaceReviews placeId={PLACE} />, { signedIn: false });
    await screen.findByTestId("guest-review");
    expect(screen.queryByTestId("complain-open")).toBeNull();
    expect(screen.queryByTestId("review-write")).toBeNull();
    expect(api.eligibility).not.toHaveBeenCalled();
  });

  it("«Залишити відгук» — только при active-праве на это место", async () => {
    renderWith(<PlaceReviews placeId={PLACE} />, {
      api: fakeApi({
        eligibility: vi.fn(async () => [
          eligibility({ id: "other", placeId: "00000000-0000-4000-8000-0000000009ff" }),
        ]),
      }),
    });
    await screen.findByTestId("guest-review");
    await waitFor(() => expect(screen.queryByTestId("review-write")).toBeNull());
  });

  it("право active — ссылка на форму; consumed — «Змінити свій відгук»", async () => {
    renderWith(<PlaceReviews placeId={PLACE} />, {
      api: fakeApi({ eligibility: vi.fn(async () => [eligibility()]) }),
    });
    const link = await screen.findByTestId("review-write-link");
    expect(link.getAttribute("href")).toBe(`#/review/${ELIG}`);
    expect(link.textContent).toBe("Залишити відгук");
    cleanup();
    renderWith(<PlaceReviews placeId={PLACE} />, {
      api: fakeApi({
        eligibility: vi.fn(async () => [eligibility({ status: "consumed", review: myReview() })]),
      }),
    });
    expect((await screen.findByTestId("review-write-link")).textContent).toBe("Змінити свій відгук");
  });
});

describe("C13: форма відгуку", () => {
  const open = (items: ReviewEligibility[], api = fakeApi()) =>
    renderWith(<ReviewScreen eligibilityId={ELIG} />, {
      api: { ...api, eligibility: vi.fn(async () => items) },
    });

  it("право не найдено — сообщение, формы нет", async () => {
    open([]);
    expect((await screen.findByTestId("review-not-found")).textContent).toContain(
      "Право на відгук не знайдено",
    );
    expect(screen.queryByTestId("review-form")).toBeNull();
  });

  it("истёкшее и отозванное право — пояснение без формы", async () => {
    open([eligibility({ status: "expired" })]);
    expect((await screen.findByTestId("review-closed")).textContent).toBe("Час для відгуку минув.");
    expect(screen.queryByTestId("review-form")).toBeNull();
    cleanup();
    open([eligibility({ status: "revoked" })]);
    expect((await screen.findByTestId("review-closed")).textContent).toContain("скасування бронювання");
  });

  it("валидация: без оценки и без текста не отправляет", async () => {
    const api = fakeApi();
    open([eligibility()], api);
    fireEvent.click(await screen.findByTestId("review-submit"));
    expect(screen.getByTestId("review-message").textContent).toContain("Оберіть оцінку");
    fireEvent.click(screen.getByRole("radio", { name: "5 з 5" }));
    fireEvent.click(screen.getByTestId("review-submit"));
    expect(screen.getByTestId("review-message").textContent).toContain("Напишіть кілька слів");
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("отправка: оценка + текст, публикуется сразу", async () => {
    const api = fakeApi();
    open([eligibility()], api);
    fireEvent.click(await screen.findByRole("radio", { name: "4 з 5" }));
    expect(screen.getByRole("radio", { name: "4 з 5" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(screen.getByLabelText("Ваш відгук"), { target: { value: "  Було чудово  " } });
    fireEvent.click(screen.getByTestId("review-submit"));
    await screen.findByText("Дякуємо! Відгук опубліковано.");
    expect(api.submit).toHaveBeenCalledWith(REGION, { eligibilityId: ELIG, rating: 4, text: "Було чудово" });
    expect(screen.getByTestId("my-review-status").textContent).toBe("Опубліковано");
  });

  it("автофильтр: отзыв на модерации — объяснение с причинами", async () => {
    open(
      [eligibility()],
      fakeApi({
        submit: vi.fn(async () => myReview({ status: "pending_moderation", autoFlags: ["link", "phone"] })),
      }),
    );
    fireEvent.click(await screen.findByRole("radio", { name: "3 з 5" }));
    fireEvent.change(screen.getByLabelText("Ваш відгук"), {
      target: { value: "дзвоніть 0501234567 t.me/x" },
    });
    fireEvent.click(screen.getByTestId("review-submit"));
    await screen.findByText("Дякуємо! Відгук на перевірці модератора.");
    expect(screen.getByTestId("my-review-flags").textContent).toContain("посилання, номер телефону");
  });

  it("ошибка сервера (окно правки закрыто) и сеть — текст по ключу; введённое сохраняется", async () => {
    const submit = vi
      .fn<ReviewsApi["submit"]>()
      .mockRejectedValueOnce(new NetworkError())
      .mockRejectedValueOnce(new ApiCallError(422, "errors.review.editWindowClosed", "UNPROCESSABLE", null));
    open([eligibility()], fakeApi({ submit }));
    fireEvent.click(await screen.findByRole("radio", { name: "5 з 5" }));
    fireEvent.change(screen.getByLabelText("Ваш відгук"), { target: { value: "Текст" } });
    fireEvent.click(screen.getByTestId("review-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("review-message").textContent).toContain("Текст збережено"),
    );
    expect((screen.getByLabelText("Ваш відгук") as HTMLTextAreaElement).value).toBe("Текст");
    fireEvent.click(screen.getByTestId("review-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("review-message").textContent).toContain("час на правку минув"),
    );
  });

  it("свой скрытый отзыв: причина и апелляция", async () => {
    const api = fakeApi();
    open(
      [
        eligibility({
          status: "consumed",
          review: myReview({ status: "hidden", hiddenReason: "Образи", canAppeal: true }),
        }),
      ],
      api,
    );
    expect((await screen.findByTestId("my-review-status")).textContent).toBe("Приховано модератором");
    expect(screen.getByTestId("my-review-reason").textContent).toBe("Причина: Образи");
    fireEvent.click(screen.getByTestId("appeal-open"));
    fireEvent.change(screen.getByLabelText("Чому ви не згодні з рішенням"), {
      target: { value: "Це не образа" },
    });
    fireEvent.click(screen.getByTestId("appeal-send"));
    await waitFor(() =>
      expect(screen.getByTestId("my-review-appeal").textContent).toBe(
        "Апеляцію подано — чекайте на рішення.",
      ),
    );
    expect(api.appeal).toHaveBeenCalledWith(REGION, REVIEW, "Це не образа");
    expect(screen.queryByTestId("appeal-open")).toBeNull();
  });
});

describe("«Мої бронювання»: вхід у відгук", () => {
  const show = (completed: boolean, e: ReviewEligibility[] | undefined, bookingId = BOOKING) =>
    renderWith(<BookingReview bookingId={bookingId} completed={completed} eligibility={e} />);

  it("завершённая бронь с active-правом — «Залишити відгук» со сроком", () => {
    show(true, [eligibility()]);
    const link = screen.getByTestId("booking-review-link");
    expect(link.textContent).toBe("Залишити відгук");
    expect(link.getAttribute("href")).toBe(`#/review/${ELIG}`);
    expect(screen.getByTestId("booking-review").textContent).toContain("Залишити відгук можна до");
  });

  it("не завершена, нет права или модуль не загрузил права — ничего", () => {
    show(false, [eligibility()]);
    expect(screen.queryByTestId("booking-review")).toBeNull();
    cleanup();
    show(true, [eligibility({ bookingId: "other" })]);
    expect(screen.queryByTestId("booking-review")).toBeNull();
    cleanup();
    show(true, undefined);
    expect(screen.queryByTestId("booking-review")).toBeNull();
  });

  it("право использовано — статус отзыва; истекло/отозвано — пояснение", () => {
    show(true, [eligibility({ status: "consumed", review: myReview({ status: "pending_moderation" }) })]);
    expect(screen.getByTestId("booking-review-status").textContent).toBe(
      "Ваш відгук: На перевірці модератора",
    );
    cleanup();
    show(true, [eligibility({ status: "expired" })]);
    expect(screen.getByTestId("booking-review-closed").textContent).toBe("Час для відгуку минув.");
    cleanup();
    show(true, [eligibility({ status: "active", expiresAt: PAST })]);
    expect(screen.getByTestId("booking-review-closed").textContent).toBe("Час для відгуку минув.");
  });
});

describe("P07: відгуки в кабінеті партнёра", () => {
  it("список: статус, ответ; пустой список — сообщение", async () => {
    renderWith(<PartnerReviews placeId={PLACE} />, {
      api: fakeApi({
        partnerReviews: vi.fn(async () => [
          partnerReview({
            response: { id: "r", text: "Перепрошуємо", version: 1, createdAt: PAST, updatedAt: PAST },
          }),
          partnerReview({ id: "h", status: "hidden", text: "Прихований" }),
        ]),
      }),
    });
    const items = await screen.findAllByTestId("partner-review");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByTestId("review-response").textContent).toContain("Перепрошуємо");
    expect(within(items[1]!).getByTestId("partner-review-status").textContent).toBe("Приховано модератором");
    // Скрытый отзыв: ответить и пожаловаться нельзя.
    expect(within(items[1]!).queryByTestId("respond-open")).toBeNull();
    expect(within(items[1]!).queryByTestId("complain-open")).toBeNull();
    cleanup();
    renderWith(<PartnerReviews placeId={PLACE} />, {
      api: fakeApi({ partnerReviews: vi.fn(async () => []) }),
    });
    expect((await screen.findByTestId("partner-reviews-empty")).textContent).toContain("ще немає");
  });

  it("ответ: уходит в API, показывается в карточке отзыва", async () => {
    const api = renderWith(<PartnerReviews placeId={PLACE} />);
    fireEvent.click(await screen.findByTestId("respond-open"));
    fireEvent.change(screen.getByLabelText("Відповідь закладу"), {
      target: { value: " Дякуємо за відгук " },
    });
    fireEvent.click(screen.getByTestId("response-send"));
    await screen.findByText("Відповідь опубліковано.");
    expect(api.respond).toHaveBeenCalledWith(REVIEW, "Дякуємо за відгук");
    expect(screen.getByTestId("review-response").textContent).toContain("Дякуємо за відгук");
    expect(screen.getByTestId("respond-open").textContent).toBe("Змінити відповідь");
  });

  it("ответ отклонён автофильтром — названы причины", async () => {
    renderWith(<PartnerReviews placeId={PLACE} />, {
      api: fakeApi({
        respond: vi.fn(async () => {
          throw new ApiCallError(422, "errors.review.responseRejected", "UNPROCESSABLE", {
            flags: ["link", "email"],
          });
        }),
      }),
    });
    fireEvent.click(await screen.findByTestId("respond-open"));
    fireEvent.change(screen.getByLabelText("Відповідь закладу"), { target: { value: "пишіть a@b.com" } });
    fireEvent.click(screen.getByTestId("response-send"));
    await waitFor(() =>
      expect(screen.getByTestId("response-error").textContent).toContain("посилання, e-mail"),
    );
    expect(screen.getByTestId("response-form")).toBeTruthy();
  });

  it("нет права отвечать (canRespond=false) — кнопки ответа нет, удалить/скрыть нельзя вовсе", async () => {
    renderWith(<PartnerReviews placeId={PLACE} />, {
      api: fakeApi({ partnerReviews: vi.fn(async () => [partnerReview({ canRespond: false })]) }),
    });
    await screen.findByTestId("partner-review");
    expect(screen.queryByTestId("respond-open")).toBeNull();
    expect(screen.queryByRole("button", { name: /Видалити|Приховати|Сховати/ })).toBeNull();
    expect(screen.getByText(/Видалити або сховати відгук не можна/)).toBeTruthy();
  });

  it("жалоба партнёра: регион берётся из отзыва; статус жалобы показан", async () => {
    const api = renderWith(<PartnerReviews placeId={PLACE} />);
    fireEvent.click(await screen.findByTestId("complain-open"));
    fireEvent.change(screen.getByLabelText("Причина"), { target: { value: "blackmail" } });
    fireEvent.click(screen.getByTestId("complaint-send"));
    await screen.findByText(/Скаргу надіслано/);
    expect(api.complain).toHaveBeenCalledWith(REGION, REVIEW, { reasonCode: "blackmail" });
    expect(screen.getByTestId("my-complaint").textContent).toContain("розглядається");
    // Открытая жалоба уже есть — повторную не предлагаем.
    expect(screen.queryByTestId("complain-open")).toBeNull();
  });

  it("апелляция: только при canAppeal; после подачи — статус", async () => {
    const api = renderWith(<PartnerReviews placeId={PLACE} />, {
      api: fakeApi({ partnerReviews: vi.fn(async () => [partnerReview({ canAppeal: true })]) }),
    });
    fireEvent.click(await screen.findByTestId("appeal-open"));
    fireEvent.change(screen.getByLabelText("Чому ви не згодні з рішенням"), {
      target: { value: "Це шантаж" },
    });
    fireEvent.click(screen.getByTestId("appeal-send"));
    await waitFor(() =>
      expect(screen.getByTestId("review-appeal-status").textContent).toBe(
        "Апеляцію подано — чекайте на рішення.",
      ),
    );
    expect(api.appeal).toHaveBeenCalledWith(REGION, REVIEW, "Це шантаж");
    expect(screen.queryByTestId("appeal-open")).toBeNull();
  });
});
