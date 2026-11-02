import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Controller, Get, Injectable, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HealthModule } from "./index.js";

// Проверка, что SWC в Vitest эмитит decorator metadata: зависимость внедряется
// только по типу параметра конструктора, без @Inject(токен).
@Injectable()
class ProbeService {
  value(): string {
    return "di-ok";
  }
}

@Controller("probe")
class ProbeController {
  constructor(private readonly probe: ProbeService) {}

  @Get()
  get(): { value: string } {
    return { value: this.probe.value() };
  }
}

describe("HealthModule (Nest DI + HTTP без listen)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HealthModule],
      controllers: [ProbeController],
      providers: [ProbeService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // без app.listen(): supertest сам поднимает сервер на эфемерном порту
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health → 200 { status: 'ok' }", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("внедряет зависимость по типу параметра конструктора (decorator metadata)", async () => {
    const res = await request(app.getHttpServer()).get("/probe");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ value: "di-ok" });
  });
});
