import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Feature, FeatureFlagsProvider, useFeatureFlag } from "./index.js";

afterEach(cleanup);

function Probe({ flag }: { flag: string }) {
  return <p data-testid="value">{String(useFeatureFlag(flag))}</p>;
}

describe("фича-флаги в UI", () => {
  it("включённый флаг — показано; выключенный и неизвестный — скрыто (или fallback)", () => {
    render(
      <FeatureFlagsProvider flags={{ "module.bookings": true, "module.reviews": false }}>
        <Feature flag="module.bookings">брони</Feature>
        <Feature flag="module.reviews" fallback={<span>нет отзывов</span>}>
          отзывы
        </Feature>
        <Feature flag="module.unknown">неизвестный</Feature>
      </FeatureFlagsProvider>,
    );
    expect(screen.queryByText("брони")).not.toBeNull();
    expect(screen.queryByText("отзывы")).toBeNull();
    expect(screen.queryByText("нет отзывов")).not.toBeNull();
    expect(screen.queryByText("неизвестный")).toBeNull();
  });

  it("флаги не загружены или провайдера нет — всё за флагами скрыто", () => {
    render(
      <>
        <FeatureFlagsProvider flags={undefined}>
          <Feature flag="module.bookings">загрузка</Feature>
        </FeatureFlagsProvider>
        <Probe flag="module.bookings" />
      </>,
    );
    expect(screen.queryByText("загрузка")).toBeNull();
    expect(screen.getByTestId("value").textContent).toBe("false");
  });

  it("ключи прототипа объекта флагами не считаются", () => {
    render(
      <FeatureFlagsProvider flags={{}}>
        <Probe flag="constructor" />
      </FeatureFlagsProvider>,
    );
    expect(screen.getByTestId("value").textContent).toBe("false");
  });
});
