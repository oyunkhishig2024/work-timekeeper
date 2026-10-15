import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "../auth/auth.module";
import { loadConfig } from "../common/config";
import { UsersModule } from "../users/users.module";
import { PlatformAuthController } from "./platform-auth.controller";
import { PlatformAuthService } from "./platform-auth.service";
import { PlatformTenantsController } from "./platform-tenants.controller";
import { PlatformTenantsService } from "./platform-tenants.service";
import { PlatformTokenService } from "./platform-token.service";
import { PlatformGuard } from "./platform.guard";

@Module({
  imports: [
    AuthModule,
    UsersModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: loadConfig().AUTH_RATE_LIMIT_PER_MINUTE }]),
  ],
  controllers: [PlatformAuthController, PlatformTenantsController],
  providers: [PlatformAuthService, PlatformTenantsService, PlatformTokenService, PlatformGuard],
  exports: [PlatformAuthService],
})
export class PlatformModule {}
