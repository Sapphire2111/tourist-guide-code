import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createApiClient } from "@tg/api-client";
import { useFeatureFlags } from "./feature-flags.js";

afterEach(cleanup);

function Probe({ api, delays }: { api: ReturnType<typeof createApiClient>; delays: number[] }) {
  const flags = useFeatureFlags(api, undefined, delays);
  return <p data-testid="flags">{flags ? JSON.stringify(flags) : "none"}</p>;
}

/** /feature-flags: первые `failures` ответов — 503, затем флаги. */
function apiFailing(failures: number) {
  let n = 0;
  const fetch = vi.fn(async () =>
    ++n <= failures
      ? Response.json({ error: { code: "SERVICE_UNAVAILABLE" } }, { status: 503 })
      : Response.json({ regionId: null, items: [{ key: "module.bookings", enabled: true }] }),
  );
  return { api: createApiClient({ baseUrl: "http://api.test", fetch }), fetch };
}

const tick = (ms = 0) => act(async () => new Promise((r) => setTimeout(r, ms)));

describe("useFeatureFlags", () => {
  it("ошибка загрузки — повтор с задержкой, затем флаги", async () => {
    const { api, fetch } = apiFailing(2);
    render(<Probe api={api} delays={[5, 5]} />);
    await tick(50);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("flags").textContent).toBe('{"module.bookings":true}');
  });

  it("повторы исчерпаны — флаги не загружены; возврат на вкладку — загрузка заново", async () => {
    const { api, fetch } = apiFailing(2);
    render(<Probe api={api} delays={[5]} />);
    await tick(50);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("flags").textContent).toBe("none");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("flags").textContent).toBe('{"module.bookings":true}');
  });
});
