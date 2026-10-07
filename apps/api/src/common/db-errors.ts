import { ApiError } from "./api-error";

interface PgError {
  code?: string;
  constraint?: string;
}

/**
 * Translates database rule violations into stable API errors (see apps/api/db/migrations/README.md).
 * Anything unrecognised is returned unchanged.
 */
export function mapDbError(error: unknown): unknown {
  const e = error as PgError;
  if (e?.code === "TK001") {
    return new ApiError(
      409,
      "CONSENT_REQUIRED",
      "The employee has no signed consent form on record.",
    );
  }
  if (e?.code === "23505") {
    if (e.constraint === "device_attestation_key_idx") {
      return new ApiError(
        409,
        "DEVICE_CONFLICT",
        "This device is already registered to another account.",
      );
    }
    if (e.constraint === "device_one_active_idx") {
      return new ApiError(
        409,
        "DEVICE_ALREADY_ACTIVE",
        "The employee already has an active device.",
      );
    }
  }
  return error;
}
