// Другие названия населённых пунктов по коду localities: курорт вместо посёлка (Буковель — Поляниця), латиница,
// падежные формы («у Буковелі»). Нужны голосовому ассистенту и поиску по тексту запроса; в БД не хранятся —
// коды пунктов стабильны (seed и places-import/config.ts), а синонимов единицы. Новый пункт — новая строка здесь.
export const LOCALITY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  yaremche: ["Яремче", "Яремчі", "Yaremche", "Yaremcha"],
  tatariv: ["Татарів", "Татарові", "Татарова", "Tatariv", "Tatarov"],
  mykulychyn: ["Микуличин", "Микуличині", "Микуличина", "Mykulychyn"],
  polianytsia: [
    "Буковель",
    "Буковелі",
    "Буковеля",
    "Bukovel",
    "Поляниця",
    "Поляниці",
    "Polianytsia",
    "Polyanytsya",
  ],
  yablunytsia: ["Яблуниця", "Яблуниці", "Yablunytsia", "Yablunytsya"],
  vorokhta: ["Ворохта", "Ворохті", "Ворохту", "Vorokhta"],
};

export function localityAliases(code: string): string[] {
  return [...(LOCALITY_ALIASES[code] ?? [])];
}
