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
  try {
    var tg = window.Telegram && window.Telegram.WebApp;
    if (tg && tg.platform !== "unknown" && (!tg.isVersionAtLeast || tg.isVersionAtLeast("6.1"))) {
      if (tg.setHeaderColor) tg.setHeaderColor(colors[1]);
      if (tg.setBackgroundColor) tg.setBackgroundColor(colors[0]);
    }
  } catch {
    // Старый клиент — стандартные цвета окна.
  }
})();
