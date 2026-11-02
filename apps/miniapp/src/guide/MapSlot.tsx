// Ленивая карта с запасным состоянием: не загрузилась (сеть, ошибка модуля) — «Карту не вдалося завантажити»,
// список рядом остаётся (C05 «ошибка карты»).
import { Component, lazy, Suspense, type ReactNode } from "react";
import { useT } from "@tg/ui";
import type { PlacesMapProps } from "./PlacesMap.js";

const PlacesMap = lazy(() => import("./PlacesMap.js"));

class MapBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function MapSlot(props: PlacesMapProps) {
  const { t } = useT();
  return (
    <MapBoundary fallback={<p role="alert">{t("miniapp.map.error")}</p>}>
      <Suspense fallback={<p role="status">{t("miniapp.guide.loading")}</p>}>
        <PlacesMap {...props} />
      </Suspense>
    </MapBoundary>
  );
}
