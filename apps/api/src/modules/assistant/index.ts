// Публичный интерфейс контекста assistant (ассистент на главной Mini App, флаг module.assistant).
export {
  ASSISTANT_QUERY_RATE_LIMIT,
  ASSISTANT_TRANSCRIBE_RATE_LIMIT,
  AssistantController,
} from "./assistant.controller.js";
export {
  ASSISTANT_AUDIO_MAX_BYTES,
  ASSISTANT_HISTORY_MAX,
  ASSISTANT_TEXT_MAX,
  AssistantIntentDto,
  AssistantPlaceDto,
  AssistantQueryDto,
  AssistantResultDto,
  AssistantTranscriptDto,
} from "./assistant.dto.js";
export { AssistantModule } from "./assistant.module.js";
export { AssistantService } from "./assistant.service.js";
export { ASSISTANT_MODEL, type AssistantIntent } from "./intent.js";
export { type AssistantConfig, type AssistantLlm, type AssistantSpeech } from "./providers.js";
