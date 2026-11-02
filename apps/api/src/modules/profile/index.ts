// Публичный интерфейс контекста profile (блок 2).
export { ProfileModule } from "./profile.module.js";
export {
  ConsentsRepository,
  MessagingConsentsRepository,
  PrivacyRequestsRepository,
} from "./profile.repositories.js";
export { ProfileService, type ProfileActor } from "./profile.service.js";
