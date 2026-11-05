import { afterEach, describe, expect, it } from "vitest";
import "@tg/i18n/en";
import { cleanup, render, screen } from "@testing-library/react";
import "@tg/i18n/admin";
import { I18nProvider, useT } from "./index.js";

afterEach(cleanup);

function Probe() {
  const { t } = useT();
  return (
    <p>
      {t("admin.title")}|{t("errors.forbidden")}
    </p>
  );
}

describe("useT", () => {
  it("без провайдера — uk", () => {
    render(<Probe />);
    expect(screen.getByText("Адмінка|Недостатньо прав для цієї дії.")).toBeDefined();
  });

  it("en: переведённый ключ — en, непереведённый — fallback uk", () => {
    render(
      <I18nProvider locale="en">
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText("Admin|Недостатньо прав для цієї дії.")).toBeDefined();
  });
});
