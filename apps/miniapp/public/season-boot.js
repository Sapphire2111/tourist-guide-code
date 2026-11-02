/* global window, document */
// Сезон темы до загрузки бандла: data-season на <html> (по месяцу или сохранённому выбору) и цвета окна Telegram —
// первый кадр уже в цветах сезона. Отдельный файл, а не inline: CSP сайта не разрешает inline-скрипты.
// Логика — как в src/design/season.ts (readSeason, WINDOW_COLORS); менять вместе.
(function () {
  var m = new Date().getMonth();
  var auto = m === 11 || m < 2 ? "winter" : m < 5 ? "spring" : m < 8 ? "summer" : "autumn";
  var season = auto;
  try {
    var saved = JSON.parse(window.localStorage.getItem("tg.season") || "null");
    if (saved && saved.auto === auto && /^(winter|spring|summer|autumn)$/.test(saved.season))
      season = saved.season;
  } catch {
    // Хранилище недоступно — сезон по дате.
  }
  document.documentElement.setAttribute("data-season", season);
  var colors = {
    winter: ["#F8F9FA", "#FFFFFF"],
    spring: ["#FBF9F5", "#FFFFFF"],
    summer: ["#FDFBF6", "#FFFFFF"],
    autumn: ["#FAF5EE", "#FFFDF9"],
  }[season];
  var tg = window.Telegram && window.Telegram.WebApp;
  if (!tg || tg.platform === "unknown") return;
  var at = function (v) {
    return !tg.isVersionAtLeast || tg.isVersionAtLeast(v);
  };
  // Каждый вызов отдельно: отказ одного (старый клиент) не отменяет другой. Шапка цветом #RRGGBB — с Bot API 6.9.
  try {
    if (at("6.1") && tg.setBackgroundColor) tg.setBackgroundColor(colors[0]);
  } catch {
    // Старый клиент — стандартный фон окна.
  }
  try {
    if (at("6.9") && tg.setHeaderColor) tg.setHeaderColor(colors[1]);
  } catch {
    // Старый клиент — стандартная шапка.
  }
})();
