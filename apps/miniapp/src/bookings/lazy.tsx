// Ленивый экран бронирований (как guide/MapSlot.tsx): чанк не загрузился (офлайн, старый хэш после деплоя) —
// сообщение и «Спробувати ще раз» вместо белого экрана; React.lazy запоминает отказ, поэтому при сбое он
// сбрасывается и повтор создаёт новый lazy. Пока чанк грузится — «Завантаження…».
import { Component, lazy, Suspense, useMemo, useState, type ComponentType, type ReactNode } from "react";
import type { MessageKey } from "@tg/i18n";
import { Button, useT } from "@tg/ui";
import { isChunkLoadError, reloadForChunkError, reloadOnceForChunkError } from "../chunk-reload.js";

class ScreenBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    // Старый чанк после деплоя: один раз автоматически обновляем страницу (дальше — кнопка).
    if (isChunkLoadError(error)) void reloadOnceForChunkError(error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Ленивый экран; `errorKey` — текст сбоя загрузки чанка (по умолчанию — для бронирований). */
export function lazyScreen<P extends object>(
  load: () => Promise<ComponentType<P>>,
  errorKey: MessageKey = "miniapp.booking.screenError",
): ComponentType<P> {
  let current: ComponentType<P> | null = null;
  let lastLoadError: unknown = null;
  const get = (): ComponentType<P> =>
    (current ??= lazy(() =>
      load().then(
        (c) => {
          lastLoadError = null;
          return { default: c };
        },
        (e: unknown) => {
          current = null;
          lastLoadError = e;
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
            <p role="alert">{t(errorKey)}</p>
            <Button
              onClick={() => {
                // Чанк потерян после деплоя — повтор import() бесполезен, перезагружаем страницу.
                if (!reloadForChunkError(lastLoadError)) setAttempt((n) => n + 1);
              }}
            >
              {t("miniapp.guide.retry")}
            </Button>
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
