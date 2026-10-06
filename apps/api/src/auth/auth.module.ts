import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { loadConfig } from "../common/config";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthGuard } from "./guards/auth.guard";
import { PasswordService } from "./password.service";
import { SecretBox } from "./secret-box";
import { SessionService } from "./session.service";
import { TokenService } from "./token.service";

@Module({
  imports: [
    // Per-IP limit for the auth endpoints (PRD 15.2); per-account protection is the lockout.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: loadConfig().AUTH_RATE_LIMIT_PER_MINUTE }]),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    SecretBox,
    SessionService,
    TokenService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, PasswordService, SecretBox, SessionService, TokenService],
})
export class AuthModule {}
