// Даты админки: показ — на языке интерфейса; границы дня фильтров — по таймзоне региона (IANA), не UTC.

/** Дата-время на языке интерфейса (`uk`, `en`). */
export function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale);
}

/** Смещение зоны относительно UTC в момент `utcMs`, мс. */
function offsetMs(utcMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(
    +parts.year!,
    +parts.month! - 1,
    +parts.day!,
    +parts.hour!,
    +parts.minute!,
    +parts.second!,
  );
  return local - utcMs;
}

/** Начало дня `YYYY-MM-DD` (+ `addDays`) в зоне `timeZone` → ISO UTC. Переход на летнее время учтён. */
export function dayStartIso(date: string, timeZone: string, addDays = 0): string {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y!, m! - 1, d! + addDays);
  let utc = guess - offsetMs(guess, timeZone);
  utc = guess - offsetMs(utc, timeZone);
  return new Date(utc).toISOString();
}
