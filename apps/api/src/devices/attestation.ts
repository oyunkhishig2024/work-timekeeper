import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import { APP_CONFIG, type AppConfig } from "../common/config";

export type AttestationState = "OK" | "FAILED" | "UNVERIFIED" | "UNAVAILABLE";

export interface AttestationInput {
  platform: "ANDROID" | "IOS";
  keyId?: string;
  publicKey?: string;
  /** Play Integrity token or App Attest object, as sent by the app. */
  token?: string;
}

/**
 * Verifies that a registration comes from a genuine, untampered app on a real device (PRD 6.7).
 * The real Google Play Integrity / Apple App Attest verifiers are built in Phase 0 Spike 2; until then
 * ATTESTATION_MODE decides what happens (see config).
 */
export abstract class AttestationVerifier {
  abstract verifyRegistration(input: AttestationInput): Promise<AttestationState>;
}

@Injectable()
export class ConfiguredAttestationVerifier extends AttestationVerifier {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  async verifyRegistration(_input: AttestationInput): Promise<AttestationState> {
    if (this.config.ATTESTATION_MODE === "disabled") return "UNVERIFIED";
    throw new ApiError(
      503,
      "ATTESTATION_UNAVAILABLE",
      "Device attestation is required but no verifier is available yet.",
    );
  }
}
