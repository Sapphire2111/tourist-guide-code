// Unit: формат start_param QR (ТЗ §3.3 — только непрозрачный идентификатор) и генерация кода (ADR-0016).
import { describe, expect, it } from "vitest";
import { checkStartParam, generateQrCode, QR_CODE_GENERATED_LENGTH, QR_CODE_RE } from "./start-param.js";

describe("checkStartParam", () => {
  it("код из латиницы, цифр, _ и - длиной 10–64 — валиден, регистр сохраняется", () => {
    for (const c of ["demoHotel01", "a".repeat(10), "Z9_-z9_-Z9", "x".repeat(64), "AbCdEf123456"])
      expect(checkStartParam(c)).toEqual({ valid: true, code: c });
  });

  it("длина вне 10–64, пустой и не строка — format", () => {
    for (const c of ["", "short", "a".repeat(9), "a".repeat(65), "x".repeat(4096)])
      expect(checkStartParam(c)).toEqual({ valid: false, reason: "format" });
    for (const c of [undefined, null, 42, ["demoHotel01"], { code: "demoHotel01" }])
      expect(checkStartParam(c)).toEqual({ valid: false, reason: "format" });
  });

  it("ПДн-подобные значения отклоняются: телефон, e-mail, имя, пробелы, кириллица, URL", () => {
    for (const c of [
      "+380501234567",
      "tourist@mail.example",
      "Іван Петренко",
      "Ivan Petrenko",
      " demoHotel01",
      "demoHotel01\n",
      "готель12345",
      "https://x.example/a",
      "<script>alert(1)</script>",
      "demo%20Hotel01",
      "../../etc/passwd",
    ])
      expect(checkStartParam(c).valid, c).toBe(false);
  });

  it("одни цифры (телефон, номер карты/документа) — digits_only", () => {
    for (const c of ["380501234567", "4111111111111111", "0000000000"])
      expect(checkStartParam(c)).toEqual({ valid: false, reason: "digits_only" });
  });
});

describe("generateQrCode", () => {
  it("12 символов base62, проходит проверку, коды различаются", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateQrCode()));
    expect(codes.size).toBe(200);
    for (const c of codes) {
      expect(c).toMatch(/^[0-9A-Za-z]{12}$/);
      expect(c).toHaveLength(QR_CODE_GENERATED_LENGTH);
      expect(QR_CODE_RE.test(c)).toBe(true);
      expect(checkStartParam(c).valid).toBe(true);
    }
  });

  it("код из одних цифр перегенерируется", () => {
    // Первые 12 «случайных» значений — цифры (0–9), дальше — буквы.
    let n = 0;
    const code = generateQrCode((max) => (n++ < QR_CODE_GENERATED_LENGTH ? n % 10 : (n % (max - 10)) + 10));
    expect(n).toBe(QR_CODE_GENERATED_LENGTH * 2);
    expect(code).toMatch(/^[A-Za-z]{12}$/);
  });
});
