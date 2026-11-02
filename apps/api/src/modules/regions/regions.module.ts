import { Module } from "@nestjs/common";
import { RegionsRepository } from "./regions.repository.js";

/** Контекст regions: пока только репозиторий (T1-09); Db — из глобального DatabaseModule. */
@Module({ providers: [RegionsRepository], exports: [RegionsRepository] })
export class RegionsModule {}
