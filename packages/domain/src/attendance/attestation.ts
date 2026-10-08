/** Verdict about an event batch (PRD 6.7). UNVERIFIED = attestation is switched off for this deployment. */
export type BatchVerdict = "OK" | "FAILED" | "UNAVAILABLE" | "UNVERIFIED";

/** PRD 6.7: five unavailable verdicts in a row from one device are escalated to HR. */
export const ATTESTATION_ESCALATION_STREAK = 5;

/**
 * The flag every event of the batch carries. An outage at Google or Apple must never block attendance, so UNAVAILABLE
 * is only noted; a definitive FAILED (tampered app, emulator, rooted) goes to the review queue.
 */
export function attestationFlag(
  verdict: BatchVerdict,
): "ATTESTATION_FAILED" | "ATTESTATION_UNAVAILABLE" | null {
  if (verdict === "FAILED") return "ATTESTATION_FAILED";
  if (verdict === "UNAVAILABLE") return "ATTESTATION_UNAVAILABLE";
  return null;
}

/**
 * Consecutive unavailable verdicts of one device. Any verdict that was actually given (OK or FAILED) ends the run;
 * UNVERIFIED (switched off) leaves it alone.
 */
export function nextUnavailableStreak(previous: number, verdict: BatchVerdict): number {
  if (verdict === "UNAVAILABLE") return previous + 1;
  if (verdict === "UNVERIFIED") return previous;
  return 0;
}

/** True exactly when this batch makes the run reach the escalation length. */
export function reachesEscalation(previous: number, verdict: BatchVerdict): boolean {
  return (
    verdict === "UNAVAILABLE" &&
    previous < ATTESTATION_ESCALATION_STREAK &&
    previous + 1 >= ATTESTATION_ESCALATION_STREAK
  );
}
