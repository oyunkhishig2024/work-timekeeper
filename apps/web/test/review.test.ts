import { describe, expect, it } from "vitest";
import {
  alertDetailText,
  decisionProblem,
  FLAG_INFO,
  mapUrl,
  parseReviewState,
  QUEUE_LABEL,
  reviewHref,
} from "../src/lib/review";

describe("review queue helpers", () => {
  it("every flag the API can put on an event has a label and an explanation", () => {
    for (const flag of [
      "MOCK_LOCATION",
      "LOW_ACCURACY",
      "CLOCK_SKEW",
      "IMPOSSIBLE_SPEED",
      "ATTESTATION_FAILED",
      "DEVICE_CONFLICT",
      "ATTESTATION_UNAVAILABLE",
      "LATE_SYNC",
    ]) {
      expect(FLAG_INFO[flag]?.label, flag).toBeTruthy();
      expect(FLAG_INFO[flag]?.help, flag).toBeTruthy();
    }
    // the two that are only noted, not suspicion (PRD 6.7, 6.8)
    expect(FLAG_INFO.LATE_SYNC!.suspicious).toBe(false);
    expect(FLAG_INFO.ATTESTATION_UNAVAILABLE!.suspicious).toBe(false);
    expect(FLAG_INFO.MOCK_LOCATION!.suspicious).toBe(true);
  });

  it("a rejection needs a reason; confirming and asking for a re-check do not", () => {
    expect(decisionProblem("REJECT", "")).toMatch(/шалтгаан/u);
    expect(decisionProblem("REJECT", "  ab ")).toMatch(/шалтгаан/u);
    expect(decisionProblem("REJECT", "Хуурамч байршил")).toBeNull();
    expect(decisionProblem("REQUEST_RECHECK", "")).toBeNull();
    expect(decisionProblem("CONFIRM", "")).toBeNull();
  });

  it("builds a map link with five decimals", () => {
    expect(mapUrl(47.918701234, 106.9176)).toBe(
      "https://www.openstreetmap.org/?mlat=47.91870&mlon=106.91760#map=17/47.91870/106.91760",
    );
  });

  it("keeps the filter in the URL and ignores anything unknown", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(reviewHref({})).toBe("/review");
    expect(reviewHref({ status: "OPEN" })).toBe("/review");
    expect(reviewHref({ status: "ALL", employeeId: id })).toBe(`/review?status=ALL&employee=${id}`);
    expect(parseReviewState(new URLSearchParams(`status=ALL&employee=${id}`))).toEqual({
      status: "ALL",
      employeeId: id,
    });
    expect(parseReviewState(new URLSearchParams("status=PENDING&employee=1%27"))).toEqual({
      status: "OPEN",
      employeeId: null,
    });
    expect(Object.keys(QUEUE_LABEL)).toEqual(["OPEN", "ALL", "CONFIRMED", "REJECTED"]);
  });

  it("translates the API's alert explanations and leaves unknown ones alone", () => {
    expect(alertDetailText("The install key differs from the registered device.")).toMatch(
      /түлхүүр/u,
    );
    expect(alertDetailText("Something new")).toBe("Something new");
    expect(alertDetailText(null)).toBeNull();
  });
});
