// Лёгкий hash-роутер вместо react-router: два-три экрана на приложение, без зависимости.
// Hash, а не History API: статика с относительными путями (PWA, любой подкаталог), без rewrite на сервере.
// Telegram кладёт в hash свои параметры (#tgWebAppData=…) — всё, что не начинается с «#/», считается «/».
import { useCallback, useSyncExternalStore, type AnchorHTMLAttributes } from "react";

/** Путь из location.hash: `#/partner?x=1` → `/partner`. */
export function pathFromHash(hash: string): string {
  if (!hash.startsWith("#/")) return "/";
  return hash.slice(1).split("?")[0] || "/";
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** Текущий путь и переход: `const [path, navigate] = useRoute();`; `replace` — без новой записи истории. */
export function useRoute(): [string, (to: string, opts?: { replace?: boolean }) => void] {
  const path = useSyncExternalStore(
    subscribe,
    () => pathFromHash(window.location.hash),
    () => "/",
  );
  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    if (opts?.replace) {
      // Не location.replace: он сбросил бы history.state записи (учёт истории приложения живёт в нём).
      window.history.replaceState(window.history.state, "", `#${to}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } else window.location.hash = to;
  }, []);
  return [path, navigate];
}

/** Ссылка на путь приложения. */
export function Link({
  to,
  ...props
}: { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return <a href={`#${to}`} {...props} />;
}
