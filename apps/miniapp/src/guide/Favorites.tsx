// Обране (C20, часть «Места»): только с сессией Telegram.
import { Stack, useT } from "@tg/ui";
import { useAsync, useGuide } from "./context.js";
import { AsyncView, PlaceList } from "./parts.js";

function FavoriteList() {
  const { t } = useT();
  const { api } = useGuide();
  const [list, retry] = useAsync(() => api.favorites(), [api]);
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
