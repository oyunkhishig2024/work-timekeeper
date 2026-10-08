import { Inject, Injectable } from "@nestjs/common";
import type { BatchVerdict } from "@timekeeper/domain";
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
  /**
   * The verdict about one batch of attendance events (PRD 6.7). Throwing means the verdict service could not be reached:
   * the caller records UNAVAILABLE, accepts the batch and flags it.
   */
  abstract verifyBatch(input: AttestationInput): Promise<BatchVerdict>;
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

  async verifyBatch(input: AttestationInput): Promise<BatchVerdict> {
    if (this.config.ATTESTATION_MODE === "disabled") return "UNVERIFIED";
    // Every batch must carry a verdict token (PRD 6.7); a client that sends none is not the genuine app.
    if (!input.token) return "FAILED";
    // The Play Integrity / App Attest verifiers are not built yet: until they are, a token cannot be checked.
    throw new Error("No attestation verifier is available.");
  }
}
