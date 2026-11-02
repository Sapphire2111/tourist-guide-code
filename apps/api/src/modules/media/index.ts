// Публичный интерфейс контекста media (T1-20): файлы и изображения, подписанные ссылки, ресайз.
export { MediaModule, type MediaModuleOptions } from "./media.module.js";
export {
  InlineMediaJobs,
  MEDIA_JOBS,
  QueueMediaJobs,
  type MediaJobRef,
  type MediaJobs,
  type MediaProcessingMode,
} from "./media.jobs.js";
export { MediaRepository } from "./media.repository.js";
export {
  MEDIA_STORAGE,
  MediaError,
  MediaService,
  type CreateUploadInput,
  type MediaErrorReason,
  type MediaLink,
} from "./media.service.js";
