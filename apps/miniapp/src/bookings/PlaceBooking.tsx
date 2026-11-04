// Бронь в карточке места (C06, флаг module.bookings): бейдж «Доступно зараз» — только при реальном свободном слоте
// или ручном статусе партнёра с неистёкшим TTL (BR-04, считает сервер), иначе «Уточнити доступність»; кнопка
// «Забронювати» → C07/C08 — если у места есть ресурсы бронирования.
import { Link, useT } from "@tg/ui";
import { Badge } from "../guide/parts.js";
import type { Resource } from "./bookings-api.js";

export function AvailabilityBadge({ resources }: { resources: Resource[] | null }) {
  const { t } = useT();
  const now = resources?.some((r) => r.availability.availableNow) ?? false;
  // «Уточнити доступність» не показываем: функции доступности пока нет (данные API не трогаем).
  return now ? (
    <Badge testId="badge-availability" tone="accent">
      {t("miniapp.booking.availableNow")}
    </Badge>
  ) : null;
}

export function BookingEntry({
  placeId,
  resources,
  signedIn,
}: {
  placeId: string;
  resources: Resource[] | null;
  signedIn: boolean;
}) {
  const { t } = useT();
  if (!resources?.length) return null;
  return (
    <div data-testid="place-booking">
      {signedIn ? (
        <Link to={`/book/${placeId}`} className="kosiv-cta" data-testid="place-book">
          {t("miniapp.booking.book")}
        </Link>
      ) : (
        <p className="pc-muted pc-small">{t("miniapp.booking.needsLogin")}</p>
      )}
    </div>
  );
}
