// Короткий ИИ-текст карточки «що це і чим цікаво» (places:enrich --ai): 2–3 предложения на украинском только из
// собранных фактов (Google Place Details + Вікіпедія). Генерируется офлайн через Message Batches API (дешевле вдвое),
// не при запросе туриста. Результат кэшируется в файл по хэшу входа: повторный прогон не платит за те же факты.
// Ключ — ANTHROPIC_API_KEY из env (SDK читает сам); в код, логи и кэш не попадает.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { PlaceEnrichmentGoogle, PlaceEnrichmentWiki } from "../db/index.js";

export const AI_MODEL = "claude-sonnet-5-5";
/** Версия промпта: меняется — тексты генерируются заново (входит в хэш). */
export const AI_PROMPT_VERSION = "2";
/** Ответ модели, когда фактов мало: текст не пишется. */
export const AI_NO_DATA = "НЕМАЄ ДАНИХ";
const AI_MAX_TOKENS = 4000;

/** Подписи удобств для промпта (uk, как в карточке). */
export const AMENITY_LABELS_UK: Readonly<Record<string, string>> = {
  breakfast: "сніданки",
  brunch: "бранчі",
  lunch: "обіди",
  dinner: "вечері",
  coffee: "кава",
  dessert: "десерти",
  beer: "пиво",
  wine: "вино",
  cocktails: "коктейлі",
  vegetarian: "вегетаріанські страви",
  dine_in: "можна поїсти на місці",
  takeout: "їжа з собою",
  delivery: "доставка",
  curbside_pickup: "видача біля входу",
  reservable: "бронювання",
  outdoor_seating: "тераса / місця надворі",
  live_music: "жива музика",
  kids_menu: "дитяче меню",
  good_for_children: "підходить для дітей",
  good_for_groups: "для компаній",
  watching_sports: "трансляції спорту",
  dogs_allowed: "можна з собакою",
  restroom: "туалет",
  parking_free: "безкоштовне паркування",
  parking_paid: "платне паркування",
  wheelchair_entrance: "вхід для візків",
  wheelchair_parking: "стоянка для людей з інвалідністю",
  wheelchair_restroom: "доступний туалет",
  wheelchair_seating: "місця для візків",
  cards: "оплата карткою",
  nfc: "безконтактна оплата",
  cash_only: "лише готівка",
};

const PRICE_UK = ["безкоштовно", "недорого", "середні ціни", "дорого", "дуже дорого"];

export type AiFactsInput = {
  name: string;
  /** Наша категория (uk): «Ресторани». */
  category: string;
  locality: string | null;
  address: string | null;
  google: PlaceEnrichmentGoogle | null;
  wiki: PlaceEnrichmentWiki | null;
};

/** Факты для модели — только то, что есть; пустые поля не передаются. */
export type AiFacts = Record<string, unknown>;

export function buildFacts(input: AiFactsInput): AiFacts | null {
  const g = input.google;
  const facts: AiFacts = { назва: input.name, категорія: input.category };
  if (g?.typeLabel) facts["тип за Google"] = g.typeLabel;
  if (input.locality) facts["населений пункт"] = input.locality;
  if (input.address) facts["адреса"] = input.address;
  if (g?.summary) facts["опис Google"] = g.summary;
  if (g?.rating !== null && g?.rating !== undefined && g.ratingCount)
    facts["рейтинг Google"] = `${g.rating} з 5 (${g.ratingCount} оцінок)`;
  if (g?.priceLevel !== null && g?.priceLevel !== undefined) facts["ціни"] = PRICE_UK[g.priceLevel];
  if (g?.amenities.length) facts["що пропонує"] = g.amenities.map((a) => AMENITY_LABELS_UK[a] ?? a);
  if (g?.reviews.length)
    facts["відгуки відвідувачів"] = g.reviews.slice(0, 5).map((r) => ({
      оцінка: r.rating,
      текст: r.text.slice(0, 500),
    }));
  if (input.wiki) facts["Вікіпедія"] = input.wiki.extract;
  // Мало фактов — текст не генерируется (иначе модель «додумает»).
  const substantial =
    Boolean(g?.summary) ||
    Boolean(input.wiki) ||
    (g?.reviews.filter((r) => r.text.length >= 40).length ?? 0) >= 2 ||
    (g?.amenities.length ?? 0) >= 3;
  return substantial ? facts : null;
}

export const SYSTEM_PROMPT = `Ти пишеш короткий текст для картки місця в путівнику для туристів (Карпати, Україна).
Завдання: 2–3 речення українською — що це за місце і чим воно може бути цікаве туристу.

Суворі правила:
- Використовуй ЛИШЕ факти з повідомлення користувача (JSON). Не додавай нічого, чого там немає: жодних страв, цін, років, історій, відстаней, послуг, епітетів про вигляд чи атмосферу, якщо вони прямо не названі у фактах.
- Думки з відгуків подавай лише як думку відвідувачів («відвідувачі хвалять …»), не як факт; не цитуй імена.
- Не вигадуй і не узагальнюй рейтинг; можна згадати його лише як є.
- Без реклами, оклику, емодзі, лапок-ялинок навколо всього тексту, markdown, посилань, телефонів, годин роботи.
- Не повторюй адресу, рейтинг і повний перелік послуг — картка показує їх окремо; згадай 1–2 найхарактерніші риси.
- До 300 символів. Звичайний нейтральний стиль путівника.
- Якщо фактів замало для змістовного тексту, відповідай рівно: ${AI_NO_DATA}`;

/**
 * Режим --covers-source wikimedia: текст Вікіпедії (CC BY-SA) — только источник фактов, пересказ своими словами. В
 * обычном режиме правила нет: промпт входит в хэш, и его смена сняла бы готовые тексты при прогоне без --ai.
 */
export const WIKI_RULE = `
- Факт «Вікіпедія» — лише джерело фактів (висота, розташування, історія тощо): перекажи їх своїми словами, не копіюй речень і зворотів зі статті дослівно.`;

export const systemPrompt = (facts: AiFacts, paraphrase = false) =>
  paraphrase && facts["Вікіпедія"] ? `${SYSTEM_PROMPT}${WIKI_RULE}` : SYSTEM_PROMPT;

/**
 * Признак текста режима Wikimedia в ai_input_hash (без миграции: CHECK допускает 16–64 hex-символа): 8 символов префикса
 * и 32 символа хэша — всего 40; хэш обычного режима всегда 32. Такой текст обычный прогон не снимает и не заменяет.
 */
const WIKIMEDIA_HASH_PREFIX = "57ed1a00";

export const isWikimediaHash = (hash: string | null | undefined) =>
  hash?.length === WIKIMEDIA_HASH_PREFIX.length + 32 && hash.startsWith(WIKIMEDIA_HASH_PREFIX);

export function factsHash(facts: AiFacts, paraphrase = false): string {
  const hash = createHash("sha256")
    .update(`${AI_MODEL}|${AI_PROMPT_VERSION}|${systemPrompt(facts, paraphrase)}|${JSON.stringify(facts)}`)
    .digest("hex")
    .slice(0, 32);
  return paraphrase ? `${WIKIMEDIA_HASH_PREFIX}${hash}` : hash;
}

/** Параметры одного запроса (и для Batches, и для теста). */
export function requestParams(facts: AiFacts, paraphrase = false): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: AI_MODEL,
    max_tokens: AI_MAX_TOKENS,
    // Короткий текст по фактам: низкое усилие — дешевле, качество достаточное.
    output_config: { effort: "low" },
    system: systemPrompt(facts, paraphrase),
    messages: [{ role: "user", content: `Факти про місце (JSON):\n${JSON.stringify(facts, null, 1)}` }],
  };
}

/** Цепочка из стольких слов подряд — уже оборот, а не название или факт («водоспад на річці Прут» — 4 слова). */
const COPY_NGRAM = 5;
/**
 * Копией считается: ≥ 20 % пятисловий текста есть в статье или ≥ 8 совпавших слов подряд. В тексте 2–3 предложения,
 * ≈ 40 слов и ≈ 36 пятисловий: одна общая фактическая фраза — 3 %, две-три — до 15 %, это нормальный пересказ; 20 % —
 * уже несколько переписанных оборотов; 8 слов подряд — целая часть предложения (CC BY-SA, дословно не копировать).
 */
const COPY_MAX_SHARE = 0.2;
const COPY_MAX_RUN_WORDS = 8;

const copyWords = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’'ʼ`]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Текст переписывает статью дословно (без учёта регистра, знаков и порядка предложений). */
export function copiesSource(text: string, source: string | null | undefined): boolean {
  if (!source) return false;
  const t = copyWords(text);
  const s = copyWords(source);
  if (t.length < COPY_NGRAM || s.length < COPY_NGRAM) return false;
  const grams = new Set<string>();
  for (let i = 0; i + COPY_NGRAM <= s.length; i++) grams.add(s.slice(i, i + COPY_NGRAM).join(" "));
  const total = t.length - COPY_NGRAM + 1;
  let hits = 0;
  let run = 0;
  let longest = 0;
  for (let i = 0; i < total; i++) {
    run = grams.has(t.slice(i, i + COPY_NGRAM).join(" ")) ? run + 1 : 0;
    if (run) hits++;
    longest = Math.max(longest, run);
  }
  return hits / total >= COPY_MAX_SHARE || (longest > 0 && longest + COPY_NGRAM - 1 >= COPY_MAX_RUN_WORDS);
}

const wikiSource = (facts: AiFacts) => {
  const v = facts["Вікіпедія"];
  return typeof v === "string" ? v : null;
};

/**
 * Проверка ответа модели: только текст, 1–4 предложения, 30–500 символов, без ссылок/разметки/телефонов, не копия
 * статьи source. Иное (в т. ч. «НЕМАЄ ДАНИХ») — null: текст в карточку не попадёт.
 */
export function acceptText(raw: string, source?: string | null): string | null {
  const t = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["«](.*)["»]$/, "$1")
    .trim();
  if (!t || t.toUpperCase().includes(AI_NO_DATA)) return null;
  if (t.length < 30 || t.length > 500) return null;
  if (/https?:|www\.|[*#_`[\]<>]|\+?\d[\d\s-]{8,}/i.test(t)) return null;
  const sentences = t.split(/[.!?…]+(?:\s|$)/).filter((s) => s.trim().length > 0);
  if (sentences.length > 4) return null;
  if (copiesSource(t, source)) return null;
  return t;
}

export type AiResult = { text: string | null; model: string; generatedAt: string };

/** paraphrase — режим Wikimedia: в промпте правило пересказа (WIKI_RULE), хэш считан с ним же. */
export type AiItem = { hash: string; facts: AiFacts; paraphrase?: boolean };

export type AiPlace = {
  googlePlaceId: string;
  name: string;
  categoryCode: string;
  localityCode: string;
  address: string | null;
  google: PlaceEnrichmentGoogle | null;
  googleFromImport?: boolean;
  wiki?: PlaceEnrichmentWiki | null | undefined;
};

/**
 * Что отправить в ИИ. Режим Wikimedia: только туда, где текста нет (по всем местам), только при найденной статье и
 * только с фактами статьи — без сохранённых данных Google. Из кэша импорта: только где текста нет. keepText — текст
 * режима Wikimedia, обычный прогон его не заменит, платить незачем.
 */
export function buildAiItems(
  places: readonly AiPlace[],
  o: {
    withAi: ReadonlySet<string>;
    wikimediaOnly: boolean;
    keepText?: ReadonlySet<string>;
    categoryName: (code: string) => string;
    localityName: (code: string) => string | null;
  },
): Map<string, AiItem> {
  const items = new Map<string, AiItem>();
  for (const p of places) {
    if ((o.wikimediaOnly || p.googleFromImport) && o.withAi.has(p.googlePlaceId)) continue;
    if (o.keepText?.has(p.googlePlaceId)) continue;
    if (o.wikimediaOnly && !p.wiki) continue;
    const facts = buildFacts({
      name: p.name,
      category: o.categoryName(p.categoryCode),
      locality: o.localityName(p.localityCode),
      address: p.address,
      google: o.wikimediaOnly ? null : p.google,
      wiki: p.wiki ?? null,
    });
    if (facts)
      items.set(p.googlePlaceId, {
        hash: factsHash(facts, o.wikimediaOnly),
        facts,
        paraphrase: o.wikimediaOnly,
      });
  }
  return items;
}

/**
 * Копии статьи из кэша результатов (пакет прошлых прогонов мог быть принят без статьи под рукой) удаляются: иначе текст
 * считался бы готовым навсегда и не создавался заново. Возвращает, сколько удалено.
 */
export async function purgeCopies(store: AiStore, items: Iterable<AiItem>): Promise<number> {
  let purged = 0;
  for (const it of items) {
    const cached = await store.get(it.hash);
    if (cached?.text && copiesSource(cached.text, wikiSource(it.facts))) {
      await store.remove(it.hash);
      purged++;
    }
  }
  return purged;
}

/** Кэш результатов и состояние отправленного пакета — файлы в каталоге кэша. */
export class AiStore {
  constructor(private readonly cacheDir: string) {}

  private file(hash: string) {
    return path.join(this.cacheDir, `ai-${hash}.json`);
  }
  private get pendingFile() {
    return path.join(this.cacheDir, "ai-batch-pending.json");
  }

  async get(hash: string): Promise<AiResult | null> {
    try {
      const v: unknown = JSON.parse(await readFile(this.file(hash), "utf8"));
      if (typeof v === "object" && v !== null && "model" in v && "generatedAt" in v) return v as AiResult;
    } catch {
      // нет
    }
    return null;
  }
  async put(hash: string, r: AiResult): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(this.file(hash), JSON.stringify(r));
  }
  async remove(hash: string): Promise<void> {
    await rm(this.file(hash), { force: true });
  }
  async pending(): Promise<{ batchId: string; hashes: string[] } | null> {
    try {
      const v = JSON.parse(await readFile(this.pendingFile, "utf8")) as {
        batchId?: unknown;
        hashes?: unknown;
      };
      if (typeof v.batchId === "string" && Array.isArray(v.hashes))
        return v as { batchId: string; hashes: string[] };
    } catch {
      // нет
    }
    return null;
  }
  async setPending(p: { batchId: string; hashes: string[] } | null): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    if (p) await writeFile(this.pendingFile, JSON.stringify(p));
    else await rm(this.pendingFile, { force: true });
  }
}

/** Часть клиента Anthropic, нужная пакетам (подменяется в тестах). */
export type BatchesApi = Pick<Anthropic["messages"]["batches"], "create" | "retrieve" | "results">;

export type AiRunStats = {
  /** Нужно сгенерировать (нет в кэше). */
  needed: number;
  submitted: number;
  /** Получено из пакета: принято, отклонено проверкой / «нет данных», ошибок. */
  accepted: number;
  rejected: number;
  /** Отброшено как копия статьи: в кэш не идёт, следующий прогон с --ai создаст текст заново. */
  copies: number;
  errored: number;
  batchId: string | null;
  /** Пакет ещё обрабатывается (результаты — при следующем прогоне). */
  stillProcessing: boolean;
  usage: { inputTokens: number; outputTokens: number };
};

/** Текст из ответа модели: только text-блоки; отказ или обрыв (max_tokens) — null (повторить позже). */
function messageText(m: Anthropic.Message): string | null {
  if (m.stop_reason === "refusal" || m.stop_reason === "max_tokens") return null;
  return m.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ");
}

/**
 * Генерация через Message Batches: сначала дособирает отправленный ранее пакет (ai-batch-pending.json), затем
 * отправляет новый на недостающие тексты (не больше maxNew). wait — ждать окончания пакета (опрос), иначе выйти.
 */
export async function runAi(
  batches: BatchesApi,
  store: AiStore,
  items: readonly AiItem[],
  opts: { maxNew: number; wait: boolean; pollMs?: number; maxWaitMs?: number; log?: (s: string) => void },
): Promise<AiRunStats> {
  const log = opts.log ?? (() => {});
  const stats: AiRunStats = {
    needed: 0,
    submitted: 0,
    accepted: 0,
    rejected: 0,
    copies: 0,
    errored: 0,
    batchId: null,
    stillProcessing: false,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  const sourceOf = new Map(items.map((it) => [it.hash, wikiSource(it.facts)]));

  const collect = async (batchId: string): Promise<boolean> => {
    const started = Date.now();
    for (;;) {
      const b = await batches.retrieve(batchId);
      if (b.processing_status === "ended") break;
      if (!opts.wait || Date.now() - started > (opts.maxWaitMs ?? 3 * 3600_000)) {
        log(`Пакет ${batchId}: ${b.processing_status}, обрабатывается ${b.request_counts.processing}`);
        stats.stillProcessing = true;
        return false;
      }
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 30_000));
    }
    const generatedAt = new Date().toISOString();
    for await (const r of await batches.results(batchId)) {
      if (r.result.type !== "succeeded") {
        stats.errored++;
        continue;
      }
      const msg = r.result.message;
      stats.usage.inputTokens += msg.usage.input_tokens;
      stats.usage.outputTokens += msg.usage.output_tokens;
      // Отказ или обрыв по max_tokens — не окончательный ответ: в кэш не пишется, следующий прогон повторит.
      const raw = messageText(msg);
      if (raw === null) {
        stats.errored++;
        continue;
      }
      const text = acceptText(raw);
      if (text && copiesSource(text, sourceOf.get(r.custom_id))) {
        stats.copies++;
        continue;
      }
      if (text) stats.accepted++;
      else stats.rejected++;
      await store.put(r.custom_id, { text, model: msg.model || AI_MODEL, generatedAt });
    }
    await store.setPending(null);
    return true;
  };

  const pending = await store.pending();
  if (pending) {
    stats.batchId = pending.batchId;
    log(`Дособираю пакет ${pending.batchId} (${pending.hashes.length} мест)`);
    if (!(await collect(pending.batchId))) return stats;
  }

  const missing: AiItem[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.hash)) continue;
    seen.add(it.hash);
    if (!(await store.get(it.hash))) missing.push(it);
  }
  stats.needed = missing.length;
  const batch = missing.slice(0, opts.maxNew);
  if (!batch.length) return stats;
  const created = await batches.create({
    requests: batch.map((it) => ({ custom_id: it.hash, params: requestParams(it.facts, it.paraphrase) })),
  });
  stats.batchId = created.id;
  stats.submitted = batch.length;
  await store.setPending({ batchId: created.id, hashes: batch.map((b) => b.hash) });
  log(`Отправлен пакет ${created.id}: ${batch.length} мест`);
  await collect(created.id);
  return stats;
}

/** Грубая оценка токенов (≈3 символа на токен для кириллицы в JSON) — для отчёта до отправки. */
export function estimateTokens(items: readonly AiItem[]): { input: number; output: number } {
  const sys = Math.ceil(SYSTEM_PROMPT.length / 3);
  let input = 0;
  for (const it of items) input += sys + Math.ceil(JSON.stringify(it.facts).length / 3) + 20;
  // Ответ ~350 символов (~150 токенов) + размышления на низком усилии (~250).
  return { input, output: items.length * 400 };
}

/** Цена Batches API для claude-sonnet-5-5: $2/$10 за 1M токенов, пакет — 50 %. */
export const AI_BATCH_USD_PER_MTOK = { input: 1, output: 5 } as const;
