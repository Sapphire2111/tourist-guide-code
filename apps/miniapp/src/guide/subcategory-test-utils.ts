import { fireEvent, screen, within } from "@testing-library/react";

/** Открывает лист SubcategorySelect (кнопка с testid) и выбирает пункт по названию. */
export function pickSub(name: string | RegExp, trigger = "subcategory-select") {
  fireEvent.click(screen.getByTestId(trigger));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("radio", { name }));
}
