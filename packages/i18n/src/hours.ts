// Круглосуточный график: единое правило для API, ассистента и мини-приложения (изоморфно, без DOM и Node).

/** "HH:MM" или "HH:MM:SS" → "HH:MM"; "24:00" остаётся как есть. */
const hhmm = (t: string): string => t.slice(0, 5);

/**
 * Интервал покрывает весь день: открытие в 00:00, закрытие в 23:59 или 24:00.
 * Так импорт Google («Open 24 hours», период без close) хранит круглосуточные места — 00:00–23:59 на все 7 дней.
 */
export function isAllDay(opens: string, closes: string): boolean {
  return hhmm(opens) === "00:00" && ["23:59", "24:00"].includes(hhmm(closes));
}
