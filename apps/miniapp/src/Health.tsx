import { useEffect, useState } from "react";
import type { ApiClient } from "@tg/api-client";
import { useT } from "@tg/ui";

type State = "checking" | "ok" | "error";

/** Статус api через типизированный клиент: проверка связки фронт → api (и CORS). */
export function Health({ api }: { api: ApiClient }) {
  const { t } = useT();
  const [state, setState] = useState<State>("checking");
  useEffect(() => {
    let alive = true;
    const set = (s: State) => alive && setState(s);
    api.GET("/health").then(
      ({ data }) => set(data?.status === "ok" ? "ok" : "error"),
      () => set("error"),
    );
    return () => {
      alive = false;
    };
  }, [api]);
  return (
    <section aria-labelledby="health-title">
      <h2 id="health-title">{t("miniapp.health.title")}</h2>
      <p role="status" data-testid="health" data-state={state}>
        {t(`miniapp.health.${state}`)}
      </p>
    </section>
  );
}
