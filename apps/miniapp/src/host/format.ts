// Время/дата для экранов блока 5: локаль интерфейса, часовой пояс региона (IANA из контекста входа);
// без пояса или при неизвестном поясе — пояс устройства.
function format(
  iso: string,
  locale: string,
  timeZone: string | null,
  opts: Intl.DateTimeFormatOptions,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale, { ...opts, ...(timeZone ? { timeZone } : {}) }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, opts).format(date);
  }
}

export function formatTime(iso: string, locale: string, timeZone: string | null = null): string {
  return format(iso, locale, timeZone, { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(iso: string, locale: string, timeZone: string | null = null): string {
  return format(iso, locale, timeZone, { dateStyle: "short", timeStyle: "short" });
}
