import { Controller, Get } from "@nestjs/common";
import { Public } from "../../auth/decorators";

@Controller("health")
export class HealthController {
  @Public()
  @Get()
  check(): { status: "ok"; time: string } {
    return { status: "ok", time: new Date().toISOString() };
  }
}
