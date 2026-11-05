// Части редактора: пресеты графика, разбор ссылок Google Maps, фото (загрузка сразу, подтверждение удаления), выбор точки.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { I18nProvider } from "@tg/ui";
import { noopPartnerApi, PartnerProvider } from "./context.js";
import { LocationPicker, parseMapsLink } from "./LocationPicker.js";
import type { PartnerApi, PartnerPlace } from "./partner-api.js";
import { Photos } from "./Photos.js";
import {
  activePreset,
  commonTime,
  nextInterval,
  presetRows,
  ScheduleForm,
  sameSchedule,
  withCommonTime,
  withDays,
  type Row,
} from "./ScheduleForm.js";

afterEach(cleanup);

const row = (dayOfWeek: number, opensAt = "09:00", closesAt = "18:00"): Row => ({
  dayOfWeek,
  opensAt,
  closesAt,
});

describe("пресеты графика", () => {
  it("«Щодня», «Пн–Пт», «Пн–Сб» — по интервалу на день с общим временем", () => {
    expect(presetRows("daily").map((r) => r.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(presetRows("weekdays", { opensAt: "10:00", closesAt: "20:00" })).toEqual(
      [1, 2, 3, 4, 5].map((d) => row(d, "10:00", "20:00")),
    );
    expect(presetRows("sixdays").map((r) => r.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("«Цілодобово» — 00:00–23:59 на все дни, независимо от времени", () => {
    const rows = presetRows("allday", { opensAt: "10:00", closesAt: "20:00" });
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.opensAt === "00:00" && r.closesAt === "23:59")).toBe(true);
    expect(activePreset(rows)).toBe("allday");
  });

  it("выбранный вариант определяется по дням и времени; разное время — «mixed»", () => {
    expect(activePreset(presetRows("weekdays"))).toBe("weekdays");
    expect(activePreset([row(1), row(2, "10:00")])).toBeNull();
    expect(commonTime([row(1), row(2, "10:00")])).toBe("mixed");
    expect(commonTime([row(1), row(1, "19:00", "22:00")])).toBe("mixed");
    expect(commonTime([])).toBeNull();
  });

  it("дни и общее время: новые дни получают время, снятые пропадают, интервалы остальных сохраняются", () => {
    const rows = [row(1, "08:00", "12:00"), row(1, "14:00", "18:00"), row(2)];
    const next = withDays(rows, [1, 3], { opensAt: "09:00", closesAt: "17:00" });
    expect(next).toEqual([row(1, "08:00", "12:00"), row(1, "14:00", "18:00"), row(3, "09:00", "17:00")]);
    expect(withCommonTime(next, { opensAt: "10:00", closesAt: "19:00" })).toEqual([
      row(1, "10:00", "19:00"),
      row(3, "10:00", "19:00"),
    ]);
  });

  it("сравнение без учёта порядка и секунд", () => {
    expect(sameSchedule([row(2), row(1)], [row(1, "09:00:00", "18:00:00"), row(2)])).toBe(true);
    expect(sameSchedule([row(1)], [row(1, "09:00", "19:00")])).toBe(false);
  });
});

function Harness({ initial }: { initial: Row[] }) {
  const [rows, setRows] = useState(initial);
  return (
    <I18nProvider locale="uk">
      <ScheduleForm rows={rows} onChange={setRows} />
      <output data-testid="rows">{JSON.stringify(rows)}</output>
    </I18nProvider>
  );
}
const rowsOut = () => JSON.parse(screen.getByTestId("rows").textContent!) as Row[];

describe("ScheduleForm", () => {
  it("чип «Пн–Пт» ставит будни; день-чип добавляет субботу; «Вихідний» убирает день", () => {
    render(<Harness initial={[]} />);
    expect(screen.getByText("Оберіть, у які дні ви працюєте.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Пн–Пт" }));
    expect(rowsOut().map((r) => r.dayOfWeek)).toEqual([1, 2, 3, 4, 5]);
    expect(screen.getByRole("button", { name: "Пн–Пт" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Субота" }));
    expect(rowsOut().map((r) => r.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6]);
    fireEvent.click(screen.getByLabelText("Вихідний: Понеділок"));
    expect(rowsOut().map((r) => r.dayOfWeek)).toEqual([2, 3, 4, 5, 6]);
  });

  it("одно время для выбранных дней меняет все дни; своё время дня — только его", () => {
    render(<Harness initial={presetRows("weekdays")} />);
    fireEvent.change(screen.getByLabelText("Закриття"), { target: { value: "20:00" } });
    expect(rowsOut().every((r) => r.closesAt === "20:00")).toBe(true);
    fireEvent.change(screen.getByLabelText("Відкриття, Вівторок"), { target: { value: "11:00" } });
    expect(rowsOut().find((r) => r.dayOfWeek === 2)?.opensAt).toBe("11:00");
    expect(rowsOut().find((r) => r.dayOfWeek === 1)?.opensAt).toBe("09:00");
    expect(screen.getByTestId("schedule-mixed")).toBeDefined();
  });

  it("разное время по дням: общие поля времени отключены, интервалы не затираются", () => {
    render(<Harness initial={[row(1), row(2, "10:00", "20:00")]} />);
    expect((screen.getByLabelText("Закриття") as HTMLInputElement).disabled).toBe(true);
    expect(rowsOut()).toEqual([row(1), row(2, "10:00", "20:00")]);
  });

  it("«Додати інтервал» ставит интервал после последнего; места нет — кнопка отключена; пустое время не принимается", () => {
    render(<Harness initial={[row(1, "08:00", "12:00")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Додати інтервал, Понеділок" }));
    expect(rowsOut()).toEqual([row(1, "08:00", "12:00"), row(1, "12:00", "14:00")]);
    fireEvent.change(screen.getAllByLabelText("Відкриття, Понеділок")[1]!, { target: { value: "" } });
    expect(rowsOut()[1]).toEqual(row(1, "12:00", "14:00"));
    cleanup();
    render(<Harness initial={[row(1, "18:00", "02:00")]} />);
    expect(
      (screen.getByRole("button", { name: "Додати інтервал, Понеділок" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(nextInterval([row(1, "09:00", "23:59")])).toBeNull();
    expect(nextInterval([])).toEqual({ opensAt: "09:00", closesAt: "18:00" });
  });

  it("«Цілодобово» после будней — все семь дней 00:00–23:59", () => {
    render(<Harness initial={presetRows("weekdays")} />);
    fireEvent.click(screen.getByRole("button", { name: "Цілодобово" }));
    expect(rowsOut()).toHaveLength(7);
    expect(rowsOut()[0]).toEqual(row(1, "00:00", "23:59"));
  });
});

describe("ссылки Google Maps", () => {
  it.each([
    [
      "https://www.google.com/maps/place/Hotel/@48.3101,25.0912,17z/data=!3m1!4b1",
      { lat: 48.3101, lon: 25.0912 },
    ],
    [
      "https://www.google.com/maps/place/Hotel/@48.3,25.1,17z/data=!4m5!3d48.31234!4d25.09876",
      { lat: 48.31234, lon: 25.09876 },
    ],
    ["https://maps.google.com/?q=48.3101,25.0912", { lat: 48.3101, lon: 25.0912 }],
    ["https://www.google.com/maps?q=48.3101%2C25.0912&z=15", { lat: 48.3101, lon: 25.0912 }],
    ["https://www.google.com/maps?ll=48.31,25.09&z=15", { lat: 48.31, lon: 25.09 }],
    ["https://www.google.com/maps/search/?api=1&query=48.31,25.09", { lat: 48.31, lon: 25.09 }],
    ["https://www.google.com/maps/place/48.31,25.09", { lat: 48.31, lon: 25.09 }],
    ["  48.3101, 25.0912 ", { lat: 48.3101, lon: 25.0912 }],
    ["48.3101 25.0912", { lat: 48.3101, lon: 25.0912 }],
    ["https://www.google.com/maps/@-33.8,151.2,12z", { lat: -33.8, lon: 151.2 }],
  ])("%s", (input, expected) => {
    expect(parseMapsLink(input)).toEqual(expected);
  });

  it("скорочене посилання — «short»; мусор, пустое и координаты вне диапазона — null", () => {
    expect(parseMapsLink("https://maps.app.goo.gl/AbCdEf123")).toBe("short");
    expect(parseMapsLink("https://goo.gl/maps/xyz")).toBe("short");
    expect(parseMapsLink("привіт")).toBeNull();
    expect(parseMapsLink("")).toBeNull();
    expect(parseMapsLink("https://www.google.com/maps/@148.3,25.1,12z")).toBeNull();
    expect(parseMapsLink("https://www.google.com/maps?q=Hotel+Smereka")).toBeNull();
  });
});

describe("LocationPicker", () => {
  function Pick({ initial = ["", ""] }: { initial?: [string, string] }) {
    const [c, setC] = useState(initial);
    return (
      <I18nProvider locale="uk">
        <LocationPicker lat={c[0]} lon={c[1]} onChange={(a, b) => setC([a, b])} />
        <output data-testid="coords">{c.join("|")}</output>
      </I18nProvider>
    );
  }

  it("ссылка Google Maps заполняет точку; скорочене посилання и мусор — понятная ошибка", () => {
    render(<Pick />);
    expect(screen.getByTestId("location-current").textContent).toBe("Точку ще не задано.");
    const input = screen.getByLabelText("Вставити посилання Google Maps");
    fireEvent.change(input, { target: { value: "https://maps.app.goo.gl/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Застосувати" }));
    expect(screen.getByTestId("location-message").textContent).toContain("скорочене");
    fireEvent.change(input, { target: { value: "https://www.google.com/maps/@48.31,25.09,15z" } });
    fireEvent.click(screen.getByRole("button", { name: "Застосувати" }));
    expect(screen.getByTestId("coords").textContent).toBe("48.31|25.09");
    expect(screen.getByTestId("location-current").textContent).toBe("Точка задана: 48.31, 25.09");
  });

  it("координаты вручную остаются в «Координати вручну»", () => {
    render(<Pick initial={["48.3", "25.1"]} />);
    fireEvent.change(screen.getByLabelText("Широта"), { target: { value: "48.4" } });
    expect(screen.getByTestId("coords").textContent).toBe("48.4|25.1");
  });

  it("«Змінити позначку» открывает лист (диалог) без ключа карты — с пояснением; Escape закрывает", () => {
    render(<Pick initial={["48.3", "25.1"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Змінити позначку" }));
    const dialog = screen.getByRole("dialog", { name: "Позначити на карті" });
    expect(within(dialog).getByTestId("location-sheet-coords").textContent).toBe("Точка задана: 48.3, 25.1");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Photos", () => {
  const PLACE_ID = "00000000-0000-4000-8000-00000000b001";
  const ASSET = "00000000-0000-4000-8000-00000000e001";
  const placeWith = (media: PartnerPlace["media"] = []): PartnerPlace =>
    ({
      id: PLACE_ID,
      name: { uk: "Смерека" },
      editable: true,
      media,
      mediaPreview: Object.fromEntries(
        media.map((m) => [m.mediaAssetId, `https://img/${m.mediaAssetId}.jpg`]),
      ),
    }) as unknown as PartnerPlace;
  const view = (place: PartnerPlace, api: Partial<PartnerApi>, onChanged = vi.fn()): ReactNode => (
    <I18nProvider locale="uk">
      <PartnerProvider
        api={{ ...noopPartnerApi(), me: () => Promise.resolve({ organizations: [] }), ...api } as PartnerApi}
        regionId="r1"
        enabled
      >
        <Photos place={place} onChanged={onChanged} />
      </PartnerProvider>
    </I18nProvider>
  );
  const jpeg = (name: string) => new File(["x"], name, { type: "image/jpeg" });

  it("выбор нескольких файлов загружает их сразу с подписью; плохой тип — ошибка на файл", async () => {
    const uploadPhoto = vi.fn(() => Promise.resolve());
    const onChanged = vi.fn();
    render(view(placeWith(), { uploadPhoto }, onChanged));
    fireEvent.change(screen.getByLabelText("Підпис до фото"), { target: { value: "Фасад" } });
    const input = screen.getByTestId("photo-input") as HTMLInputElement;
    expect(input.multiple).toBe(true);
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [jpeg("a.jpg"), jpeg("b.jpg"), new File(["x"], "c.gif", { type: "image/gif" })] },
      });
    });
    expect(uploadPhoto).toHaveBeenCalledTimes(2);
    expect(uploadPhoto).toHaveBeenNthCalledWith(
      1,
      PLACE_ID,
      expect.objectContaining({ name: "a.jpg" }),
      "Фасад",
    );
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("photo-uploads").textContent).toContain("c.gif");
    expect(screen.getByTestId("photo-uploads").textContent).toContain("JPEG, PNG або WebP");
  });

  it("без подписи сервер всё равно получает alt: «Назва — Фото N» с учётом уже загруженных", async () => {
    const uploadPhoto = vi.fn(() => Promise.resolve());
    const media = [
      { mediaAssetId: ASSET, sortOrder: 0, isCover: true, alt: { uk: "x" } },
    ] as unknown as PartnerPlace["media"];
    render(view(placeWith(media), { uploadPhoto }));
    await act(async () => {
      fireEvent.change(screen.getByTestId("photo-input"), {
        target: { files: [jpeg("a.jpg"), jpeg("b.jpg")] },
      });
    });
    expect(uploadPhoto).toHaveBeenNthCalledWith(1, PLACE_ID, expect.anything(), "Смерека — Фото 2");
    expect(uploadPhoto).toHaveBeenNthCalledWith(2, PLACE_ID, expect.anything(), "Смерека — Фото 3");
  });

  it("ошибка загрузки — на файле, «Повторити» пробует снова", async () => {
    const uploadPhoto = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValue(undefined);
    render(view(placeWith(), { uploadPhoto }));
    await act(async () => {
      fireEvent.change(screen.getByTestId("photo-input"), { target: { files: [jpeg("a.jpg")] } });
    });
    expect(screen.getByTestId("photo-uploads").textContent).toContain("Не вдалося завантажити фото");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Повторити" }));
    });
    expect(uploadPhoto).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("photo-uploads")).toBeNull();
  });

  it("обложка — первое фото; удаление только после подтверждения в листе", async () => {
    const deletePhoto = vi.fn(() => Promise.resolve());
    const media = [
      { mediaAssetId: ASSET, sortOrder: 0, isCover: false, alt: { uk: "Фасад" } },
      { mediaAssetId: "00000000-0000-4000-8000-00000000e002", sortOrder: 1, isCover: false, alt: null },
    ] as unknown as PartnerPlace["media"];
    render(view(placeWith(media), { deletePhoto }));
    expect(screen.getAllByText("Обкладинка")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Видалити фото: Фасад" }));
    const dialog = screen.getByRole("alertdialog", { name: "Видалити це фото?" });
    expect(deletePhoto).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Скасувати" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(deletePhoto).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Видалити фото: Фасад" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Видалити" }));
    });
    expect(deletePhoto).toHaveBeenCalledWith(PLACE_ID, ASSET);
    expect(screen.getByTestId("photos-message").textContent).toBe("Фото видалено.");
  });
});
