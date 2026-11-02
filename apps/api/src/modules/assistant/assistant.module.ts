import { Module, type DynamicModule } from "@nestjs/common";
import { GuideModule } from "../guide/index.js";
import { AssistantController } from "./assistant.controller.js";
import { AssistantRepository } from "./assistant.repository.js";
import { AssistantService } from "./assistant.service.js";
import {
  ASSISTANT_CONFIG,
  ASSISTANT_LLM,
  ASSISTANT_SPEECH,
  createAnthropicLlm,
  createGoogleSpeech,
  type AssistantConfig,
} from "./providers.js";

/**
 * Ассистент на главной Mini App (флаг module.assistant): POST /assistant/query (Claude, tool use → места каталога) и
 * POST /assistant/transcribe (Google Speech-to-Text). Поиск мест — GuideService (публичный каталог, блок 4).
 * Без ключей модуль подключается, но отвечает 503 (а не 500). `guide` — тот же объект GuideModule.forRoot, что в
 * AppModule (один экземпляр GuideService с настройками фото); без него — GuideModule без фото Google.
 */
@Module({})
export class AssistantModule {
  static forRoot(
    config: AssistantConfig,
    guide: DynamicModule | typeof GuideModule = GuideModule,
  ): DynamicModule {
    return {
      module: AssistantModule,
      imports: [guide],
      controllers: [AssistantController],
      providers: [
        AssistantRepository,
        AssistantService,
        { provide: ASSISTANT_CONFIG, useValue: config },
        { provide: ASSISTANT_LLM, useFactory: () => createAnthropicLlm(config.anthropicApiKey) },
        { provide: ASSISTANT_SPEECH, useFactory: () => createGoogleSpeech(config.googleApiKey) },
      ],
    };
  }
}
