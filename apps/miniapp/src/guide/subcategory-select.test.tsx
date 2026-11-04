import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "@tg/ui";
import { useState } from "react";
import { consumeBack, hasBackIntercept } from "../telegram.js";
import { SubcategorySelect } from "./SubcategorySelect.js";

afterEach(cleanup);

const OPTIONS = [
  { id: "all", label: "Усі" },
  { id: "a", label: "Гірські лижі" },
  { id: "b", label: "Сноуборд", icon: "🏂" },
];

function Harness({ onChange }: { onChange?: (id: string) => void }) {
  const [value, setValue] = useState("all");
  return (
    <I18nProvider locale="uk">
      <SubcategorySelect
        title="Підкатегорії"
        options={OPTIONS}
        value={value}
        onChange={(id) => {
          setValue(id);
          onChange?.(id);
        }}
      />
    </I18nProvider>
  );
}

describe("SubcategorySelect", () => {
  it("кнопка: «Шукати все», aria-haspopup=dialog; лист закрыт", () => {
    render(<Harness />);
    const btn = screen.getByTestId("subcategory-select");
    expect(btn.textContent).toContain("Шукати все");
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("лист: radiogroup, первый пункт «Шукати все» выбран; выбор применяется и закрывает лист", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByTestId("subcategory-select"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByRole("radiogroup")).toBeTruthy();
    const radios = within(dialog).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.closest("label")!.textContent)).toEqual([
      "Шукати все",
      "Гірські лижі",
      "🏂Сноуборд",
    ]);
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);

    fireEvent.click(within(dialog).getByRole("radio", { name: "Гірські лижі" }));
    expect(onChange).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("subcategory-select").textContent).toContain("Гірські лижі");
    expect(screen.getByTestId("subcategory-select").getAttribute("aria-label")).toBe(
      "Підкатегорії: Гірські лижі",
    );

    fireEvent.click(screen.getByTestId("subcategory-select"));
    expect((screen.getByRole("radio", { name: "Гірські лижі" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Шукати все" }));
    expect(onChange).toHaveBeenLastCalledWith("all");
    expect(screen.getByTestId("subcategory-select").textContent).toContain("Шукати все");
  });

  it("закрытие без выбора: фон, Escape, «Закрити», «Назад» Telegram", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const open = () => fireEvent.click(screen.getByTestId("subcategory-select"));

    open();
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    fireEvent.click(screen.getByRole("button", { name: "Закрити" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    expect(hasBackIntercept()).toBe(true);
    act(() => {
      expect(consumeBack()).toBe(true);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hasBackIntercept()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});
