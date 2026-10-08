import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AbuseMiddleware } from "./abuse.middleware";
import { AbuseService } from "./abuse.service";
import { IpBlockStore } from "./ip-block.store";

/** Adaptive, behaviour-based IP throttling and temporary bans (see README.md in this folder). Attached with `applyAbuseProtection(app)`. */
@Module({
  imports: [AuthModule],
  providers: [AbuseService, AbuseMiddleware, IpBlockStore],
  exports: [AbuseService, IpBlockStore],
})
export class SecurityModule {}
