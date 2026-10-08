import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AttestationVerifier, ConfiguredAttestationVerifier } from "./attestation";
import { DevicesController } from "./devices.controller";
import { DevicesService } from "./devices.service";

@Module({
  imports: [AuthModule],
  controllers: [DevicesController],
  providers: [
    DevicesService,
    { provide: AttestationVerifier, useClass: ConfiguredAttestationVerifier },
  ],
  exports: [DevicesService, AttestationVerifier],
})
export class DevicesModule {}
