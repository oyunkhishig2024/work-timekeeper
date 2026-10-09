import type { OutboxEvent } from "./outbox";

export interface Fix {
  lat: number;
  lng: number;
  accuracyM?: number;
  mocked?: boolean;
}

/**
 * Turns what the operating system reported (a region was entered or left) into an outbox event (Architecture 7.4): a new
 * `clientEventId`, the phone's time, and the evidence of a quick position fix when there was one. No fix is not a reason to lose
 * the event: the transition itself is what the server needs; the fix only helps it check the claim.
 */
export function captureEvent(input: {
  type: "ENTER" | "EXIT";
  locationId: string;
  now: number;
  newId: () => string;
  fix?: Fix | null;
}): OutboxEvent {
  const { fix } = input;
  return {
    clientEventId: input.newId(),
    type: input.type,
    locationId: input.locationId,
    capturedAt: input.now,
    ...(fix
      ? {
          lat: fix.lat,
          lng: fix.lng,
          ...(fix.accuracyM !== undefined ? { accuracyM: fix.accuracyM } : {}),
          ...(fix.mocked ? { mockLocation: true } : {}),
        }
      : {}),
  };
}
