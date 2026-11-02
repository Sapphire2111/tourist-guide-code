import { Body, Controller, Get, HttpCode, Inject, Patch, Post, Req } from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiError, ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { RequireAuth, requestMeta, type AuthRequest } from "../auth/index.js";
import {
  ConsentDto,
  MeDto,
  MessagingConsentDto,
  PrivacyRequestDto,
  toConsentDto,
  toMessagingConsentDto,
  toPrivacyRequestDto,
} from "./profile.dto.js";
// DTO тел запросов нужны в рантайме: emitDecoratorMetadata передаёт класс в ValidationPipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ConsentChangeDto,
  CreatePrivacyRequestDto,
  MessagingConsentChangeDto,
  UpdateMeDto,
} from "./profile.dto.js";
import { ProfileService, type ProfileActor } from "./profile.service.js";

/**
 * Профиль текущего пользователя (C15, блок 2): только свои данные по сессии (`*.own` — неявное право вошедшего).
 * Без tenant-контекста: таблицы профиля global, а у туриста назначений и региона нет.
 */
@ApiTags("profile")
@Controller("me")
@RequireAuth()
@WithoutTenantContext()
export class ProfileController {
  constructor(@Inject(ProfileService) private readonly profile: ProfileService) {}

  @Get()
  @ApiOperation({ operationId: "getMe", summary: "Профиль: язык, имя, Telegram, согласия, запросы данных" })
  @ApiOkResponse({ type: MeDto })
  @ApiErrors("UNAUTHENTICATED")
  get(@Req() req: AuthRequest): Promise<MeDto> {
    return this.profile.me(actorOf(req).userId);
  }

  @Patch()
  @ApiOperation({ operationId: "updateMe", summary: "Изменить язык интерфейса и/или имя отображения" })
  @ApiOkResponse({ type: MeDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED")
  update(@Req() req: AuthRequest, @Body() body: UpdateMeDto): Promise<MeDto> {
    return this.profile.update(actorOf(req), { language: body.language, displayName: body.displayName });
  }

  @Post("consents")
  @HttpCode(200)
  @ApiOperation({
    operationId: "changeMyConsent",
    summary: "Принять или отозвать согласие (условия, политика, сервисные/маркетинговые) с версией текста",
  })
  @ApiOkResponse({ type: ConsentDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND")
  async changeConsent(@Req() req: AuthRequest, @Body() body: ConsentChangeDto): Promise<ConsentDto> {
    return toConsentDto(await this.profile.changeConsent(actorOf(req), body));
  }

  @Post("messaging-consent")
  @HttpCode(200)
  @ApiOperation({
    operationId: "changeMyMessagingConsent",
    summary: "Разрешение боту писать (результат requestWriteAccess): сервисные и маркетинговые раздельно",
  })
  @ApiOkResponse({ type: [MessagingConsentDto] })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "UNPROCESSABLE")
  async changeMessagingConsent(
    @Req() req: AuthRequest,
    @Body() body: MessagingConsentChangeDto,
  ): Promise<MessagingConsentDto[]> {
    return (await this.profile.changeMessagingConsent(actorOf(req), body)).map(toMessagingConsentDto);
  }

  @Post("privacy-requests")
  @ApiOperation({
    operationId: "createMyPrivacyRequest",
    summary: "Запрос экспорта или удаления данных (каркас): статус received; открытый того же вида — он же",
  })
  @ApiCreatedResponse({ type: PrivacyRequestDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED")
  async createPrivacyRequest(
    @Req() req: AuthRequest,
    @Body() body: CreatePrivacyRequestDto,
  ): Promise<PrivacyRequestDto> {
    return toPrivacyRequestDto(await this.profile.createPrivacyRequest(actorOf(req), body.kind));
  }
}

function actorOf(req: AuthRequest): ProfileActor {
  const principal = req.principal;
  if (!principal) throw new ApiError("UNAUTHENTICATED");
  return { userId: principal.userId, sessionId: principal.sessionId, meta: requestMeta(req) };
}
