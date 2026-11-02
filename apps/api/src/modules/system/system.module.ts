import { Module } from "@nestjs/common";
import { HealthModule } from "../health/index.js";

// Пример второго контекста: зависимость от health — только через его index.ts.
@Module({ imports: [HealthModule] })
export class SystemModule {}
