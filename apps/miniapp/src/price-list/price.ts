// Цены прайса заведения (миграция 0030): копейки ↔ поле ввода («180», «99,50»), показ «від 180 грн за порцію».
import type { Translator } from "@tg/i18n";

/** Максимум цены, копейки (PRICE_MINOR_MAX сервера: 10 000 000 грн). */
export const PRICE_MINOR_MAX = 1_000_000_000;

/**
 * Ввод цены в гривнях → копейки: «180», «180,5», «99.50», «1 500» (пробелы — разделители тысяч). null — не число,
 * больше двух знаков после запятой, отрицательное или больше максимума.
 */
export function parsePrice(raw: string): number | null {
  const text = raw.replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(minor) && minor <= PRICE_MINOR_MAX ? minor : null;
}

/** Копейки → текст поля ввода: «180», «99,50» (без разделителей тысяч — их не нужно стирать при правке). */
export function priceInput(minor: number): string {
  const whole = Math.floor(minor / 100);
  const frac = minor % 100;
  return frac ? `${whole},${String(frac).padStart(2, "0")}` : String(whole);
}

type Translate = Translator["t"];

/** Сумма по локали: целые гривни — без копеек, иначе два знака. */
export function amountOf(minor: number, locale: string): string {
  const fraction = minor % 100 ? 2 : 0;
  return new Intl.NumberFormat(locale, { minimumFractionDigits: fraction, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
}

/** «180 грн», «від 1 500 грн», «від 1 500 грн за 2 години». */
export function priceText(
  t: Translate,
  locale: string,
  item: { priceMinor: number; priceFrom: boolean },
  unit?: string | null,
): string {
  const price = t("miniapp.price.amount", { amount: amountOf(item.priceMinor, locale) });
  const base = item.priceFrom ? t("miniapp.price.from", { price }) : price;
  return unit ? `${base} ${unit}` : base;
}
