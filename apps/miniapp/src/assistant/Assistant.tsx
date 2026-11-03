// Экран ассистента: диалог «реплика → места каталога». Места, цены и описания — только из ответа api (каталог и
// обогащение); модель на сервере выбирает лишь категории и фильтры. Уточнения — следующей репликой или чипом;
// контекст диалога (прежние реплики и намерение) хранится здесь и отправляется с каждым запросом.
import { useEffect, useMemo, useRef, useState } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Stack, useRoute, useT } from "@tg/ui";
import { useCategoryIndex, type CategoryIndex } from "../guide/categories.js";
import { useGuide } from "../guide/context.js";
import { MapSlot, preloadMap } from "../guide/MapSlot.js";
import { useRadiusLabel } from "../guide/Nearby.js";
import { PlaceSummaryCard } from "../guide/parts.js";
import { useErrorText } from "../host/errors.js";
import type { AssistantApi, AssistantIntent, AssistantItem, AssistantResult } from "./assistant-api.js";
import { AssistantBox } from "./AssistantBox.js";

import { clearAssistantDialog, loadDialog, newDialogId, saveDialog, type Turn } from "./dialog-store.js";

export { DIALOG_KEY } from "./dialog-store.js";

/** Что ищем — по намерению: категории (названия из справочника), фильтры. */
export function useIntentSummary(index: CategoryIndex): (intent: AssistantIntent) => string {
  const { t, locale } = useT();
  const radius = useRadiusLabel();
  return (intent) => {
    const byCode = new Map(index.list.filter((c) => c.code).map((c) => [c.code!, c]));
    const parts = intent.categories.map((code) => {
      const c = byCode.get(code);
      return c ? pickLocalized(c.name, locale) : code;
    });
    if (!parts.length && intent.nameQuery)
      parts.push(t("miniapp.assistant.anything", { q: intent.nameQuery }));
    if (intent.kind === "tour") parts.push(t("miniapp.assistant.filter.tour"));
    if (intent.radiusMeters)
      parts.push(t("miniapp.assistant.filter.radius", { r: radius(intent.radiusMeters) }));
    if (intent.priceMax !== null && intent.priceMax <= 2) parts.push(t("miniapp.assistant.filter.cheap"));
    if (intent.priceMin !== null && intent.priceMin >= 3) parts.push(t("miniapp.assistant.filter.pricey"));
    if (intent.withKids) parts.push(t("miniapp.assistant.filter.kids"));
    if (intent.openNow) parts.push(t("miniapp.assistant.filter.open"));
    return t("miniapp.assistant.searching", { what: parts.join(", ") });
  };
}

export function Assistant({ api, initialQuery = "" }: { api: AssistantApi; initialQuery?: string }) {
  const { t } = useT();
  const guide = useGuide();
  const index = useCategoryIndex(guide.api);
  const summary = useIntentSummary(index);
  const errorText = useErrorText();
  const [, navigate] = useRoute();
  // Новый запрос с главной — новый диалог; возврат на #/assistant — прежний диалог из sessionStorage.
  const [restored] = useState(() => (initialQuery.trim() ? null : loadDialog()));
  const dialogId = useRef(restored?.id ?? newDialogId());
  const [turns, setTurns] = useState<Turn[]>(() => restored?.turns ?? []);
  const nextId = useRef(turns.length + 1);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => saveDialog(dialogId.current, turns), [turns]);
  const point = guide.base?.point ?? null;

  const ask = (text: string) => {
    const id = nextId.current++;
    // Контекст — завершённые реплики этого диалога и намерение последнего ответа.
    const done = turns.filter((x) => x.state.status === "ready");
    const lastReady = done[done.length - 1];
    const previous = lastReady?.state.status === "ready" ? lastReady.state.data.intent : null;
    setTurns((all) => [...all, { id, text, state: { status: "loading" } }]);
    api
      .ask({ text, point, history: turns.map((x) => x.text), previous })
      .then(
        (data) => ({ status: "ready", data }) as const,
        (error: unknown) => ({ status: "error", error }) as const,
      )
      .then((state) => {
        // Ушли с экрана до ответа — ответ всё равно сохраняется в диалог (вернёмся — не платим повторно).
        if (!alive.current) {
          // Только в свой диалог: если уже начат новый (другой id), поздний ответ не дописывается.
          const stored = loadDialog();
          const mine = stored?.id === dialogId.current ? stored.turns : stored ? null : [];
          if (state.status === "ready" && mine) saveDialog(dialogId.current, [...mine, { id, text, state }]);
          return;
        }
        setTurns((all) => all.map((x) => (x.id === id ? { ...x, state } : x)));
      });
  };

  // Запрос с главной (#/assistant?q=…) — сразу первой репликой.
  const started = useRef(false);
  useEffect(() => {
    preloadMap().catch(() => undefined);
    if (started.current || !initialQuery.trim()) return;
    started.current = true;
    ask(initialQuery.trim());
    // Адрес без запроса: «Назад» из карточки места вернёт диалог, а не повторит запрос.
    navigate("/assistant", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const last = turns[turns.length - 1];
  const busy = last?.state.status === "loading";
  const result = last?.state.status === "ready" ? last.state.data : null;

  return (
    <Stack>
      <h1>{t("miniapp.assistant.title")}</h1>
      <p className="kosiv-muted">{t("miniapp.assistant.hint")}</p>
      {turns.length > 0 && (
        <ol
          className="assistant-dialog"
          aria-label={t("miniapp.assistant.dialog")}
          data-testid="assistant-dialog"
        >
          {turns.map((turn) => (
            <li key={turn.id}>
              <p className="assistant-you">
                <strong>{t("miniapp.assistant.you")}:</strong> {turn.text}
              </p>
              <p
                className="assistant-reply"
                role={turn.state.status === "error" ? "alert" : undefined}
                data-testid="assistant-reply"
              >
                {turn.state.status === "loading"
                  ? t("miniapp.assistant.thinking")
                  : turn.state.status === "error"
                    ? errorText(turn.state.error, "miniapp.assistant.error")
                    : turn.state.data.intent.clarify
                      ? t("miniapp.assistant.clarify")
                      : summary(turn.state.data.intent)}
              </p>
            </li>
          ))}
        </ol>
      )}
      {/* Ответ на последнюю реплику: количество объявляется читалкой. */}
      <p role="status" className="kosiv-muted" data-testid="assistant-status">
        {busy
          ? t("miniapp.assistant.thinking")
          : result && !result.intent.clarify
            ? result.items.length
              ? t("miniapp.assistant.found", { n: result.items.length })
              : t("miniapp.assistant.empty")
            : ""}
      </p>
      {result && <ResultView result={result} />}
      {result && result.intent.suggestions.length > 0 && (
        <div
          role="group"
          aria-label={t("miniapp.assistant.chips")}
          className="kosiv-tags"
          data-testid="assistant-chips"
        >
          {result.intent.suggestions.map((s) => {
            const label = t(`miniapp.assistant.chip.${s}` as MessageKey);
            return (
              <button key={s} type="button" className="kosiv-tag" disabled={busy} onClick={() => ask(label)}>
                {label}
              </button>
            );
          })}
        </div>
      )}
      <AssistantBox api={api} onSubmit={ask} busy={busy} id="assistant-next" autoFocus={!initialQuery} />
      {turns.length > 0 && (
        <Button
          onClick={() => {
            clearAssistantDialog();
            dialogId.current = newDialogId();
            setTurns([]);
          }}
          disabled={busy}
        >
          {t("miniapp.assistant.newDialog")}
        </Button>
      )}
    </Stack>
  );
}

function ResultView({ result }: { result: AssistantResult }) {
  const { t } = useT();
  const { base } = useGuide();
  const distance = useRadiusLabel();
  // Тот же массив между рендерами — карта не перестраивает маркеры при каждом рендере экрана.
  const places = useMemo(() => result.items.map((i) => i.place), [result]);
  if (result.intent.clarify || !result.items.length) return null;
  const tour = result.intent.kind === "tour";
  return (
    <Stack>
      {result.notes.map((n) => (
        <p key={n} className="kosiv-muted" data-testid="assistant-note">
          {t(`miniapp.assistant.note.${n}` as MessageKey)}
        </p>
      ))}
      {tour && (
        <p data-testid="assistant-route">
          {result.route
            ? t("miniapp.assistant.tour", { n: places.length, len: distance(result.route.lengthMeters) })
            : t("miniapp.assistant.tourNoLine", { n: places.length })}
        </p>
      )}
      <MapSlot places={places} center={base?.point ?? null} centerLabel={base?.name} route={tour} />
      <ol className="assistant-list" data-testid="assistant-places">
        {result.items.map((item, i) => (
          <AssistantPlace key={item.place.id} item={item} stop={tour ? i + 1 : null} />
        ))}
      </ol>
    </Stack>
  );
}

function AssistantPlace({ item, stop }: { item: AssistantItem; stop: number | null }) {
  const { t } = useT();
  const price =
    item.priceLevel !== null && item.priceLevel >= 0 && item.priceLevel <= 4
      ? t(`miniapp.place.price.${item.priceLevel}` as MessageKey)
      : null;
  return (
    <li data-testid="assistant-place">
      {stop !== null && <p className="assistant-stop">{t("miniapp.assistant.stopN", { n: stop })}</p>}
      <PlaceSummaryCard place={item.place} as="div" />
      {(price || item.kidsFriendly || item.description) && (
        <div className="assistant-extra">
          {(price || item.kidsFriendly) && (
            <p className="kosiv-place-meta">
              {price && <span className="kosiv-chip">{price}</span>}
              {item.kidsFriendly && <span className="kosiv-chip">{t("miniapp.assistant.kids")}</span>}
            </p>
          )}
          {item.description && (
            <>
              <p data-testid="assistant-description">{item.description}</p>
              <p className="kosiv-muted assistant-source">
                {item.descriptionSource === "wikipedia" && item.descriptionUrl ? (
                  <a href={item.descriptionUrl} target="_blank" rel="noopener noreferrer">
                    {t("miniapp.assistant.source.wikipedia")}
                  </a>
                ) : item.descriptionSource ? (
                  t(`miniapp.assistant.source.${item.descriptionSource}` as MessageKey)
                ) : null}
              </p>
            </>
          )}
        </div>
      )}
    </li>
  );
}
