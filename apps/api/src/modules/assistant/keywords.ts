// Поиск по блюду, кухне или особенности («суші», «піца», «з терасою»): ключевые слова намерения → группы синонимов и
// написаний (uk/ru/en) → регулярное выражение Postgres (ARE) по целым словам. Ищется в названии, типе Google,
// описаниях и отзывах места (AssistantRepository.keywordMatches). Чистая логика без БД.

/**
 * Группы синонимов: слово туриста или модели из группы (или начинающееся с основы «…*») — ищем всю группу.
 * «*» — любое окончание (піца, піцу, піцерія). Без «*» — только целое слово: «суши» не находит «сушити».
 */
export const KEYWORD_GROUPS: readonly (readonly string[])[] = [
  [
    "суші",
    "суши",
    "sushi",
    "рол",
    "роли",
    "ролів",
    "ролами",
    "ролли",
    "роллы",
    "роллов",
    "rolls",
    "японськ*",
    "японск*",
    "japanese",
  ],
  ["піц*", "пиц*", "pizz*"],
  ["бургер*", "гамбургер*", "burger*"],
  ["шаурм*", "шаверм*", "шаварм*", "shawarma", "шаурмичн*"],
  [
    "кава",
    "кави",
    "каву",
    "кавою",
    "кав'ярн*",
    "кофе",
    "кофейн*",
    "coffee*",
    "еспресо",
    "эспрессо",
    "espresso",
    "капучино",
    "cappuccino",
  ],
  ["вареник*", "varenyk*"],
  ["банош*", "бануш*", "banosh*", "banush*"],
  ["дерун*", "драник*"],
  ["борщ*", "borsch*"],
  ["шашлик*", "шашлык*", "барбекю", "bbq", "гриль", "grill*"],
  ["стейк*", "steak*"],
  ["форел*", "trout"],
  ["хачапур*", "хінкал*", "хинкал*", "грузинськ*", "грузинск*", "georgian"],
  ["паста", "пасту", "пастою", "pasta", "італійськ*", "итальянск*", "italian"],
  ["рамен*", "ramen", "вок", "wok", "азійськ*", "азиатск*", "asian"],
  ["морозив*", "мороженое", "gelato"],
  ["десерт*", "dessert*", "тістеч*", "пирожн*", "кондитер*"],
  ["пиво", "пива", "пивн*", "крафтов*", "beer*", "паб", "pub"],
  ["вино", "вина", "винн*", "wine*"],
  ["веган*", "vegan*", "вегетаріан*", "вегетариан*", "vegetarian*"],
  ["тераса", "терасою", "терасі", "терасу", "террас*", "terrace*"],
  ["сніданк*", "сніданок", "завтрак*", "breakfast*", "бранч*", "brunch*"],
  ["кальян*", "hookah", "shisha"],
  ["басейн*", "бассейн*", "pool"],
  ["чан", "чани", "чану", "чанів", "чаном", "чанах", "чанами"],
  ["саун*", "sauna*", "лазн*", "баня", "бані", "баню", "банька"],
];

/** Апостроф в любом написании: ' ’ ʼ. */
const APOSTROPHES = /['’ʼ]/g;
const norm = (w: string) => w.toLowerCase().replace(APOSTROPHES, "'").replace(/\s+/g, " ").trim();

/** Слово подходит под запись группы: целиком или по основе «…*». */
function matches(entry: string, word: string): boolean {
  return entry.endsWith("*") ? word.startsWith(entry.slice(0, -1)) : word === entry;
}

/** Слова → термы поиска: группы синонимов целиком + сами слова (без повторов). */
export function expandKeywords(words: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of words) {
    const w = norm(raw);
    if (w.length < 2) continue;
    // Фраза из нескольких слов — каждое слово тоже ищет свою группу («суші бар» → суші…).
    const parts = [w, ...(w.includes(" ") ? w.split(" ") : [])];
    for (const group of KEYWORD_GROUPS)
      if (parts.some((p) => group.some((e) => matches(e, p)))) group.forEach((e) => out.add(e));
    // Само слово — тоже (написания модели может не быть в словаре).
    out.add(w);
  }
  return [...out];
}

/** Короче — в названии ищем целым словом, длиннее — и внутри слитного названия («KitsuneSushi»). */
const SUBSTRING_MIN = 5;

/** Экранирование спецсимволов регулярного выражения Postgres (ARE). */
const escapeRe = (s: string) => s.replace(/[.^$*+?()[\]{}|\\]/g, (c) => `\\${c}`);

/**
 * Термы → регулярное выражение Postgres для `~*` по целым словам: `\m(?:суші|піц\w*|…)\M`. Апостроф — любой.
 * wholeWords = false — подстрока (для названий: «KitsuneSushi» слитно). Пусто — null (искать нечего).
 */
export function keywordPattern(terms: readonly string[], wholeWords = true): string | null {
  const alts = [...new Set(terms.map(norm).filter((t) => t.replace("*", "").length >= 2))].map((t) => {
    const prefix = t.endsWith("*");
    const stem = prefix ? t.slice(0, -1) : t;
    const body = escapeRe(stem).replace(/'/g, "['’ʼ]");
    if (wholeWords) return prefix ? `${body}\\w*` : body;
    // Подстрока — только для длинных слов: «рол», «кава», «вино» внутри названий («Королівська») — не они.
    return stem.length < SUBSTRING_MIN ? `\\m${body}${prefix ? "\\w*" : ""}\\M` : body;
  });
  if (!alts.length) return null;
  return wholeWords ? `\\m(?:${alts.join("|")})\\M` : `(?:${alts.join("|")})`;
}
