/* global window, document */
/* eslint-disable @typescript-eslint/no-unused-vars -- catch (e): старые WebView (до ES2019) не знают catch без привязки. */
// Сезон темы до загрузки бандла: data-season на <html> (по месяцу или сохранённому выбору) и цвета окна Telegram —
// первый кадр уже в цветах сезона. Отдельный файл, а не inline: CSP сайта не разрешает inline-скрипты.
// Логика — как в src/design/season.ts (readSeason) и theme.ts (WINDOW_COLORS); менять вместе.
(function () {
  document.documentElement.setAttribute("data-design", "modern");
  var m = new Date().getMonth();
  var auto = m === 11 || m < 2 ? "winter" : m < 5 ? "spring" : m < 8 ? "summer" : "autumn";
  var season = auto;
  try {
    var saved = JSON.parse(window.localStorage.getItem("tg.season") || "null");
    if (saved && saved.auto === auto && /^(winter|spring|summer|autumn)$/.test(saved.season))
      season = saved.season;
  } catch (e) {
    // Хранилище недоступно — сезон по дате.
  }
  document.documentElement.setAttribute("data-season", season);
  // Тема: «Ніч» (по умолчанию) или «День»; повреждённое значение и недоступное хранилище — «Ніч». Как в src/design/theme.ts.
  var theme = "night";
  try {
    if (window.localStorage.getItem("tg.theme") === "day") theme = "day";
  } catch (e) {
    // Хранилище недоступно — «Ніч».
  }
  document.documentElement.setAttribute("data-theme", theme);
  // [шапка, низ]: верх неба и низ картинки фона, как WINDOW_COLORS (theme.ts).
  var colors = theme === "night" ? ["#071510", "#1D1612"] : ["#FDE8D0", "#16382B"];
  var tg = window.Telegram && window.Telegram.WebApp;
  if (!tg || tg.platform === "unknown") return;
  var at = function (v) {
    return !tg.isVersionAtLeast || tg.isVersionAtLeast(v);
  };
  // Каждый вызов отдельно: отказ одного (старый клиент) не отменяет другой. Шапка цветом #RRGGBB — с Bot API 6.9.
  try {
    if (at("6.1") && tg.setBackgroundColor) tg.setBackgroundColor(colors[1]);
  } catch (e) {
    // Старый клиент — стандартный фон окна.
  }
  try {
    if (at("6.9") && tg.setHeaderColor) tg.setHeaderColor(colors[0]);
  } catch (e) {
    // Старый клиент — стандартная шапка.
  }
  try {
    if (at("7.10") && tg.setBottomBarColor) tg.setBottomBarColor(colors[1]);
  } catch (e) {
    // Старый клиент — стандартная нижняя панель.
  }
})();
