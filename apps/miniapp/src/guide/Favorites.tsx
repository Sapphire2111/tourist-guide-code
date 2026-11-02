// Обране (C20, часть «Места»): только с сессией Telegram.
import { Stack, useT } from "@tg/ui";
import { useAsync, useGuide } from "./context.js";
import { AsyncView, PlaceList } from "./parts.js";
import { UnauthorizedError } from "./types.js";

function FavoriteList() {
  const { t } = useT();
  const { api } = useGuide();
  const [list, retry] = useAsync(() => api.favorites(), [api]);
  // Сессия истекла — повтор не поможет: просим войти заново, без кнопки повтора.
  if (list.status === "error" && list.error instanceof UnauthorizedError)
    return (
      <p role="alert" data-testid="favorites-auth">
        {t("miniapp.auth.again")}
      </p>
    );
  return (
    <AsyncView state={list} retry={retry}>
      {(places) =>
        places.length ? (
          <PlaceList places={places} testId="favorites-list" />
        ) : (
          <p data-testid="favorites-empty">{t("miniapp.favorites.empty")}</p>
        )
      }
    </AsyncView>
  );
}

export function Favorites() {
  const { t } = useT();
  const { signedIn } = useGuide();
  return (
    <Stack>
      <h1>{t("miniapp.favorites.title")}</h1>
      {signedIn ? <FavoriteList /> : <p data-testid="favorites-login">{t("miniapp.favorites.needsLogin")}</p>}
    </Stack>
  );
}
