// Публичный интерфейс контекста emergency-contacts (блок 3/4, «Халепа?»; ADR-0018).
export {
  AdminEmergencyContactsController,
  PublicEmergencyContactsController,
} from "./emergency-contacts.controller.js";
export {
  AdminEmergencyContactDto,
  EMERGENCY_PHONE_RE,
  EmergencyContactDto,
  EmergencyContactListDto,
  toAdminEmergencyContactDto,
  toEmergencyContactDto,
} from "./emergency-contacts.dto.js";
export { EmergencyContactsModule } from "./emergency-contacts.module.js";
export {
  EMERGENCY_CONTACTS_MAX,
  EmergencyContactsRepository,
  type EmergencyContactFilter,
} from "./emergency-contacts.repository.js";
export {
  EMERGENCY_CONTACT_AUDIT,
  EMERGENCY_CONTACT_ENTITY,
  EmergencyContactsService,
  type EmergencyContactInput,
  type EmergencyContactPatch,
} from "./emergency-contacts.service.js";
