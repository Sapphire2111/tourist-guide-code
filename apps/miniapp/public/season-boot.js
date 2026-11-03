/* global window, document */
/* eslint-disable @typescript-eslint/no-unused-vars -- catch (e): старые WebView (до ES2019) не знают catch без привязки. */
// Сезон темы до загрузки бандла: data-season на <html> (по месяцу или сохранённому выбору) и цвета окна Telegram —
// первый кадр уже в цветах сезона. Отдельный файл, а не inline: CSP сайта не разрешает inline-скрипты.
// Логика — как в src/design/season.ts (readSeason, WINDOW_COLORS); менять вместе.
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
  // Тема: «День» (по умолчанию) или «Ніч»; повреждённое значение и недоступное хранилище — «День». Как в src/design/theme.ts.
  var theme = "day";
  try {
    if (window.localStorage.getItem("tg.theme") === "night") theme = "night";
  } catch (e) {
    // Хранилище недоступно — «День».
  }
  document.documentElement.setAttribute("data-theme", theme);
  var colors = {
    winter: ["#F8F9FA", "#FFFFFF"],
    spring: ["#FBF9F5", "#FFFFFF"],
    summer: ["#FDFBF6", "#FFFFFF"],
    autumn: ["#FAF5EE", "#FFFDF9"],
  }[season];
  if (theme === "night") colors = ["#091913", "#0F261D"];
  var tg = window.Telegram && window.Telegram.WebApp;
  if (!tg || tg.platform === "unknown") return;
  var at = function (v) {
    return !tg.isVersionAtLeast || tg.isVersionAtLeast(v);
  };
  // Каждый вызов отдельно: отказ одного (старый клиент) не отменяет другой. Шапка цветом #RRGGBB — с Bot API 6.9.
  try {
    if (at("6.1") && tg.setBackgroundColor) tg.setBackgroundColor(colors[0]);
  } catch (e) {
    // Старый клиент — стандартный фон окна.
  }
  try {
    if (at("6.9") && tg.setHeaderColor) tg.setHeaderColor(colors[1]);
  } catch (e) {
    // Старый клиент — стандартная шапка.
  }
})();
