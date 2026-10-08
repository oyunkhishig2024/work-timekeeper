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
  if (e?.code === "TK002") {
    return new ApiError(400, "SHIFT_MODE_REQUIRED", "The employee is not on a shift schedule.");
  }
  if (e?.code === "TK003") {
    return new ApiError(400, "WORKING_WEEK_INCOMPLETE", "A working week needs all 7 weekdays.");
  }
  if (e?.code === "TK004") {
    return new ApiError(
      400,
      "HOLIDAY_SCOPE_INVALID",
      "A holiday applies either to all locations or to a non-empty list of locations.",
    );
  }
  if (e?.code === "TK005") {
    return new ApiError(
      409,
      "SHIFT_TEMPLATE_IN_USE",
      "The shift template is already used; create a new version instead.",
    );
  }
  if (e?.code === "TK006") {
    return new ApiError(
      409,
      "SHIFT_PATTERN_IN_USE",
      "The shift pattern is already assigned; create a new pattern instead.",
    );
  }
  if (e?.code === "TK007") {
    return new ApiError(
      400,
      "SHIFT_PATTERN_INCOMPLETE",
      "The pattern must define every day of its cycle.",
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
