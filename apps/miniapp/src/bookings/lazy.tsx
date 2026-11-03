// Ленивый экран бронирований (как guide/MapSlot.tsx): чанк не загрузился (офлайн, старый хэш после деплоя) —
// сообщение и «Спробувати ще раз» вместо белого экрана; React.lazy запоминает отказ, поэтому при сбое он
// сбрасывается и повтор создаёт новый lazy. Пока чанк грузится — «Завантаження…».
import { Component, lazy, Suspense, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Button, useT } from "@tg/ui";

class ScreenBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function lazyScreen<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  let current: ComponentType<P> | null = null;
  const get = (): ComponentType<P> =>
    (current ??= lazy(() =>
      load().then(
        (c) => ({ default: c }),
        (e: unknown) => {
          current = null;
          throw e;
        },
      ),
    ));
  return function LazyScreen(props: P) {
    const { t } = useT();
    const [attempt, setAttempt] = useState(0);
    // Новая попытка — новый lazy (прежний после сбоя сброшен в get).
    const Screen = useMemo(get, [attempt]);
    return (
      <ScreenBoundary
        key={attempt}
        fallback={
          <div className="kosiv-card kosiv-empty" data-testid="screen-load-error">
            <p role="alert">{t("miniapp.booking.screenError")}</p>
            <Button onClick={() => setAttempt((n) => n + 1)}>{t("miniapp.guide.retry")}</Button>
          </div>
        }
      >
        <Suspense
          fallback={
            <p role="status" className="kosiv-muted">
              {t("miniapp.guide.loading")}
            </p>
          }
        >
          <Screen {...props} />
        </Suspense>
      </ScreenBoundary>
    );
  };
}
