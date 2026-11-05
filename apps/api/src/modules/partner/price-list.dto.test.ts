// Unit: валидация запросов прайса (0030) — длины текстов, непустой uk, цена ≥ 0 и целая, направление ▲▼, uuid
// раздела; null у необязательных полей — «очистить».
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import {
  CreatePriceItemDto,
  CreatePriceSectionDto,
  MovePriceListEntryDto,
  PRICE_MINOR_MAX,
  UpdatePriceItemDto,
  UpdatePriceSectionDto,
} from "./price-list.dto.js";

const SECTION = "0190f5c2-7d3e-7000-8000-0000000000c1";

function errors<T extends object>(cls: new () => T, body: unknown): string[] {
  const out: string[] = [];
  const walk = (list: ReturnType<typeof validateSync>, prefix = "") => {
    for (const e of list) {
      const path = prefix ? `${prefix}.${e.property}` : e.property;
      if (e.constraints) out.push(...Object.keys(e.constraints).map((c) => `${path}:${c}`));
      if (e.children?.length) walk(e.children, path);
    }
  };
  walk(validateSync(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true }));
  return out;
}

describe("DTO прайса", () => {
  it("раздел: название обязательно, не пустое, до 80 символов", () => {
    expect(errors(CreatePriceSectionDto, { title: { uk: "Страви" } })).toEqual([]);
    expect(errors(CreatePriceSectionDto, {})).toContain("title:isDefined");
    expect(errors(CreatePriceSectionDto, { title: { uk: "   " } })).toContain("title.uk:matches");
    expect(errors(CreatePriceSectionDto, { title: { uk: "я".repeat(81) } })).toContain("title.uk:maxLength");
    expect(errors(UpdatePriceSectionDto, { hidden: true, version: 2 })).toEqual([]);
    expect(errors(UpdatePriceSectionDto, { version: 0 })).toContain("version:min");
  });

  it("позиция: имя, цена — целое ≥ 0 и не больше максимума, раздел — uuid", () => {
    const ok = {
      sectionId: SECTION,
      name: { uk: "Банош" },
      priceMinor: 18000,
      priceFrom: true,
      unit: { uk: "за порцію" },
      description: { uk: "З бринзою та шкварками" },
    };
    expect(errors(CreatePriceItemDto, ok)).toEqual([]);
    expect(errors(CreatePriceItemDto, { ...ok, priceMinor: 0 })).toEqual([]);
    expect(errors(CreatePriceItemDto, { ...ok, priceMinor: -1 })).toContain("priceMinor:min");
    expect(errors(CreatePriceItemDto, { ...ok, priceMinor: 10.5 })).toContain("priceMinor:isInt");
    expect(errors(CreatePriceItemDto, { ...ok, priceMinor: PRICE_MINOR_MAX + 1 })).toContain(
      "priceMinor:max",
    );
    expect(errors(CreatePriceItemDto, { ...ok, sectionId: "nope" })).toContain("sectionId:isUuid");
    expect(errors(CreatePriceItemDto, { ...ok, name: { uk: "я".repeat(121) } })).toContain(
      "name.uk:maxLength",
    );
    expect(errors(CreatePriceItemDto, { ...ok, unit: { uk: "я".repeat(41) } })).toContain(
      "unit.uk:maxLength",
    );
    expect(errors(CreatePriceItemDto, { ...ok, description: { uk: "я".repeat(501) } })).toContain(
      "description.uk:maxLength",
    );
    const { priceMinor: _p, ...noPrice } = ok;
    expect(errors(CreatePriceItemDto, noPrice)).toContain("priceMinor:isInt");
  });

  it("правка позиции: всё необязательно, null — очистить единицу и описание; лишние поля — ошибка", () => {
    expect(errors(UpdatePriceItemDto, {})).toEqual([]);
    expect(errors(UpdatePriceItemDto, { unit: null, description: null, hidden: false })).toEqual([]);
    expect(errors(UpdatePriceItemDto, { priceMinor: -5 })).toContain("priceMinor:min");
    expect(errors(UpdatePriceItemDto, { status: "archived" })).toContain("status:whitelistValidation");
  });

  it("▲▼: только up | down", () => {
    expect(errors(MovePriceListEntryDto, { direction: "up" })).toEqual([]);
    expect(errors(MovePriceListEntryDto, { direction: "left" })).toContain("direction:isIn");
  });
});
