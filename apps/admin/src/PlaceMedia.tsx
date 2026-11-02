// Фото места (ADR-0013): POST /media/uploads → PUT файла по подписанной ссылке → POST /media/{id}/confirm →
// POST /admin/places/{id}/media. Alt text (uk) обязателен; обложка; порядок — кнопки «вище/нижче».
import { useEffect, useState } from "react";
import { Stack, useT } from "@tg/ui";
import { call, type ApiError, type ApiSchemas, type Result } from "./api.js";
import {
  ErrorBox,
  Form,
  fromLocalized,
  inputStyle,
  Loaded,
  LocalizedField,
  Notice,
  row,
  SmallButton,
  toLocalized,
  useAdmin,
  useLoad,
  type LocalizedValue,
  useBusy,
} from "./ui.js";

type Item = ApiSchemas["PlaceMediaDto"];

/** Правила файла — как у api (ADR-0013, README api «Файлы и изображения»): фото jpeg/png/webp, 1 байт…10 МиБ. */
export const MEDIA_MIME = ["image/jpeg", "image/png", "image/webp"];
export const MEDIA_MAX_SIZE = 10 * 1024 * 1024;
export const ALT_MAX = 300;
/** Опрос GET /media/{id} до ready/rejected: интервал и число попыток (около минуты; дальше — по перезагрузке). */
export const MEDIA_POLL = { intervalMs: 2000, attempts: 30 };

/** Проверка до загрузки: ключ ошибки или null. */
export function uploadProblem(file: File | null, alt: LocalizedValue): string | null {
  if (!file) return "admin.media.fileRequired";
  if (!MEDIA_MIME.includes(file.type)) return "admin.media.typeInvalid";
  if (file.size < 1 || file.size > MEDIA_MAX_SIZE) return "admin.media.sizeInvalid";
  if (!alt.uk.trim()) return "admin.media.altRequired";
  if (alt.uk.trim().length > ALT_MAX || alt.en.trim().length > ALT_MAX) return "admin.media.altTooLong";
  return null;
}

/** Превью: опрос GET /media/{id} до ready/rejected, затем вариант w320. */
function Thumb({ item }: { item: Item }) {
  const { api } = useAdmin();
  const { tDynamic } = useT();
  const [asset, setAsset] = useState<ApiSchemas["MediaAssetDto"] | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (left: number) => {
      const res = await call(api.GET("/media/{id}", { params: { path: { id: item.mediaAssetId } } }));
      if (!alive) return;
      if (res.ok) setAsset(res.data);
      const done = res.ok && (res.data.status === "ready" || res.data.status === "rejected");
      if (!done && left > 1) timer = setTimeout(() => void poll(left - 1), MEDIA_POLL.intervalMs);
    };
    void poll(MEDIA_POLL.attempts);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, item.mediaAssetId]);
  const link = asset?.links.find((x) => x.name === "w320") ?? asset?.links[0];
  if (link) return <img src={link.url} alt={item.alt?.uk ?? ""} width={160} style={{ height: "auto" }} />;
  return <span role="status">{tDynamic(`admin.mediaStatus.${asset?.status ?? item.status}`)}</span>;
}

export function PlaceMedia({ placeId }: { placeId: string }) {
  const { api } = useAdmin();
  const { t } = useT();
  const [acting, act] = useBusy();
  const [loaded] = useLoad(
    () => call(api.GET("/admin/places/{id}/media", { params: { path: { id: placeId } } })),
    [placeId],
  );
  // После изменений список приходит в ответе — он заменяет загруженный.
  const [updated, setResult] = useState<Result<{ items: Item[] }>>();
  const result = updated ?? loaded;
  const [error, setError] = useState<ApiError | null>(null);
  // Ошибка загрузки — у формы «Додати фото», не у списка.
  const [uploadError, setUploadError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState<LocalizedValue>({ uk: "", en: "" });
  const [fileKey, setFileKey] = useState(0);
  const [alts, setAlts] = useState<Record<string, LocalizedValue>>({});

  const items = result?.ok ? [...result.data.items].sort((a, b) => a.sortOrder - b.sortOrder) : [];
  const id = (mediaAssetId: string) => ({ params: { path: { id: placeId, mediaAssetId } } });

  const apply = (r: Result<{ items: Item[] }>) => {
    if (!r.ok) {
      setError(r.error);
      return false;
    }
    setError(null);
    setResult(r);
    setNotice(t("admin.saved"));
    return true;
  };

  const upload = async () => {
    setNotice(null);
    setUploadError(null);
    const problem = uploadProblem(file, alt);
    const altText = toLocalized(alt);
    if (problem || !file || !altText)
      return setUploadError({ status: 0, messageKey: problem ?? "admin.media.fileRequired" });
    const created = await call(
      api.POST("/media/uploads", {
        body: {
          ownerType: "place",
          ownerId: placeId,
          kind: "image",
          mime: file.type,
          size: file.size,
          alt: altText,
        },
      }),
    );
    if (!created.ok) return setUploadError(created.error);
    const { asset, upload: target } = created.data;
    const put = await fetch(target.url, {
      method: target.method,
      headers: target.headers,
      body: file,
    }).catch(() => null);
    if (!put?.ok) return setUploadError({ status: put?.status ?? 0, messageKey: "admin.media.uploadFailed" });
    const confirmed = await call(api.POST("/media/{id}/confirm", { params: { path: { id: asset.id } } }));
    if (!confirmed.ok) return setUploadError(confirmed.error);
    const attached = await call(
      api.POST("/admin/places/{id}/media", {
        params: { path: { id: placeId } },
        body: {
          mediaAssetId: asset.id,
          alt: altText,
          sortOrder: items.length,
          isCover: items.length === 0,
        },
      }),
    );
    if (!attached.ok) return setUploadError(attached.error);
    if (apply(attached)) {
      setFile(null);
      setFileKey((k) => k + 1); // новый <input type=file> — выбранный файл сброшен
      setAlt({ uk: "", en: "" });
    }
  };

  const move = async (index: number, dir: -1 | 1) => {
    const other = items[index + dir];
    const self = items[index];
    if (!other || !self) return;
    const first = await call(
      api.PATCH("/admin/places/{id}/media/{mediaAssetId}", {
        ...id(self.mediaAssetId),
        body: { sortOrder: index + dir },
      }),
    );
    if (!first.ok) return setError(first.error);
    apply(
      await call(
        api.PATCH("/admin/places/{id}/media/{mediaAssetId}", {
          ...id(other.mediaAssetId),
          body: { sortOrder: index },
        }),
      ),
    );
  };

  const remove = async (mediaAssetId: string) => {
    const r = await call(api.DELETE("/admin/places/{id}/media/{mediaAssetId}", id(mediaAssetId)));
    if (!r.ok) return setError(r.error);
    apply(await call(api.GET("/admin/places/{id}/media", { params: { path: { id: placeId } } })));
  };

  return (
    <section aria-labelledby="place-media">
      <Stack gap={2}>
        <h2 id="place-media" style={{ margin: 0 }}>
          {t("admin.media")}
        </h2>
        <ErrorBox error={error} />
        <Notice text={notice} />
        <Loaded result={result}>
          {() => (
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              {items.map((item, index) => {
                const value = alts[item.mediaAssetId] ?? fromLocalized(item.alt);
                const label = item.alt?.uk || t("admin.media.noAlt");
                return (
                  <li key={item.mediaAssetId} style={{ marginBottom: 16 }}>
                    <Stack gap={1}>
                      <div style={row}>
                        <Thumb item={item} />
                        {item.isCover && <strong>{t("admin.media.cover")}</strong>}
                      </div>
                      <Form
                        label={`${t("admin.media.alt")}: ${label}`}
                        submitLabel={t("admin.media.saveAlt")}
                        onSubmit={() =>
                          call(
                            api.PATCH("/admin/places/{id}/media/{mediaAssetId}", {
                              ...id(item.mediaAssetId),
                              body: { alt: toLocalized(value) },
                            }),
                          ).then(apply)
                        }
                      >
                        <LocalizedField
                          label={t("admin.media.alt")}
                          value={value}
                          required
                          maxLength={ALT_MAX}
                          onChange={(v) => setAlts((a) => ({ ...a, [item.mediaAssetId]: v }))}
                        />
                      </Form>
                      <div style={row}>
                        {!item.isCover && (
                          <SmallButton
                            aria-label={`${t("admin.media.makeCover")}: ${label}`}
                            disabled={acting}
                            onClick={() =>
                              act(() =>
                                call(
                                  api.PATCH("/admin/places/{id}/media/{mediaAssetId}", {
                                    ...id(item.mediaAssetId),
                                    body: { isCover: true },
                                  }),
                                ).then(apply),
                              )
                            }
                          >
                            {t("admin.media.makeCover")}
                          </SmallButton>
                        )}
                        <SmallButton
                          aria-label={`${t("admin.media.up")}: ${label}`}
                          disabled={acting || index === 0}
                          onClick={() => act(() => move(index, -1))}
                        >
                          {t("admin.media.up")}
                        </SmallButton>
                        <SmallButton
                          aria-label={`${t("admin.media.down")}: ${label}`}
                          disabled={acting || index === items.length - 1}
                          onClick={() => act(() => move(index, 1))}
                        >
                          {t("admin.media.down")}
                        </SmallButton>
                        <SmallButton
                          aria-label={`${t("admin.delete")}: ${label}`}
                          disabled={acting}
                          onClick={() => act(() => remove(item.mediaAssetId))}
                        >
                          {t("admin.delete")}
                        </SmallButton>
                      </div>
                    </Stack>
                  </li>
                );
              })}
            </ol>
          )}
        </Loaded>
        <h3 style={{ margin: 0 }}>{t("admin.media.add")}</h3>
        <Form
          label={t("admin.media.add")}
          onSubmit={upload}
          error={uploadError}
          submitLabel={t("admin.media.upload")}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {t("admin.media.file")} *
            <input
              key={fileKey}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              required
              style={inputStyle}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <LocalizedField
            label={t("admin.media.alt")}
            value={alt}
            onChange={setAlt}
            required
            maxLength={ALT_MAX}
          />
        </Form>
      </Stack>
    </section>
  );
}
