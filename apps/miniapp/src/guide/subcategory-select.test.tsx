import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "@tg/ui";
import { useState } from "react";
import { consumeBack, hasBackIntercept } from "../telegram.js";
import { SubcategorySelect } from "./SubcategorySelect.js";

afterEach(cleanup);

const OPTIONS = [
  { id: "all", label: "Шукати все" },
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
    const radios = within(dialog).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Шукати все", "Гірські лижі", "🏂Сноуборд"]);
    expect(radios.map((r) => r.getAttribute("aria-checked") === "true")).toEqual([true, false, false]);

    fireEvent.click(within(dialog).getByRole("radio", { name: "Гірські лижі" }));
    expect(onChange).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("subcategory-select").textContent).toContain("Гірські лижі");
    expect(screen.getByTestId("subcategory-select").getAttribute("aria-label")).toBe(
      "Підкатегорії: Гірські лижі",
    );

    fireEvent.click(screen.getByTestId("subcategory-select"));
    expect(screen.getByRole("radio", { name: "Гірські лижі" }).getAttribute("aria-checked")).toBe("true");
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

  it("фокус: на выбранном радио; закрытие возвращает фокус на кнопку", () => {
    render(<Harness />);
    const btn = screen.getByTestId("subcategory-select");
    btn.focus();
    fireEvent.click(btn);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Шукати все" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(btn);
  });

  it("Tab-ловушка по реальным остановкам: выбранное радио + «Закрити»; Shift+Tab с выбранного не уводит из листа", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("subcategory-select"));
    // Выбранное радио — не первое.
    fireEvent.click(screen.getByRole("radio", { name: "Сноуборд" }));
    fireEvent.click(screen.getByTestId("subcategory-select"));
    const picked = screen.getByRole("radio", { name: "Сноуборд" });
    const close = screen.getByRole("button", { name: "Закрити" });
    expect(document.activeElement).toBe(picked);
    expect(fireEvent.keyDown(document, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(close);
    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(picked);
    // Фокус, ушедший из листа, возвращается внутрь.
    screen.getByTestId("subcategory-select").focus();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("клавиатура: стрелки двигают фокус и не применяют; Enter/Space (click) применяют; повторный тап по выбранному закрывает", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByTestId("subcategory-select"));
    const group = screen.getByRole("radiogroup");
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Гірські лижі" }));
    fireEvent.keyDown(group, { key: "ArrowDown" });
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Шукати все" }));
    fireEvent.keyDown(group, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Сноуборд" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Enter/Space на кнопке дают click.
    fireEvent.click(document.activeElement!);
    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByTestId("subcategory-select"));
    fireEvent.click(screen.getByRole("radio", { name: "Сноуборд" }));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("выбран не «все» — кнопка акцентная (data-active) и показывает значок пункта", () => {
    render(<Harness />);
    const btn = screen.getByTestId("subcategory-select");
    expect(btn.getAttribute("data-active")).toBeNull();
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("radio", { name: "Сноуборд" }));
    expect(btn.getAttribute("data-active")).toBe("true");
    expect(btn.textContent).toContain("🏂");
  });
});
