import type { ApiClient, ApiEvent } from "@/lib/api";
import { ApiError, NetworkError, SessionEndedError } from "@/lib/errors";
import type { Outbox, OutboxEvent } from "./outbox";

const BATCH = 50;

/** What the server needs for an event, with the age worked out at upload time (PRD 6.8). */
export function toApiEvent(e: OutboxEvent, now: number): ApiEvent {
  return {
    clientEventId: e.clientEventId,
    type: e.type,
    locationId: e.locationId,
    ageMs: Math.max(0, Math.round(now - e.capturedAt)),
    deviceTime: new Date(e.capturedAt).toISOString(),
    ...(e.accuracyM !== undefined ? { accuracyM: e.accuracyM } : {}),
    ...(e.mockLocation ? { mockLocation: true } : {}),
    ...(e.lat !== undefined && e.lng !== undefined ? { lat: e.lat, lng: e.lng } : {}),
  };
}

export type FlushOutcome =
  | { state: "EMPTY" | "DONE"; sent: number }
  | { state: "OFFLINE" | "SIGNED_OUT" | "BLOCKED"; sent: number; code?: string };

/**
 * Uploads the outbox in batches (Architecture 7.4). Safe to retry: the server treats a repeated `clientEventId` as a duplicate.
 * - Whatever the server answers per event (accepted, duplicate, rejected) the event leaves the queue: a rejected one will never succeed.
 * - No network, a server error or throttling: stop and keep everything for the next try.
 * - A batch the server refuses as invalid (400) is sent one event at a time, so one bad event cannot hold the others back.
 * - 403 (device disabled, consent withdrawn, ...) and a ended session stop the upload without losing anything.
 */
export async function flushOutbox(
  outbox: Outbox,
  api: Pick<ApiClient, "postEvents">,
  now: () => number = Date.now,
): Promise<FlushOutcome> {
  let sent = 0;
  for (;;) {
    const batch = await outbox.peek(BATCH);
    if (batch.length === 0) return { state: sent === 0 ? "EMPTY" : "DONE", sent };
    try {
      const at = now();
      const res = await api.postEvents(batch.map((e) => toApiEvent(e, at)));
      await outbox.acknowledge(res.results.map((r) => r.clientEventId));
      // an event the server did not mention stays; a server that answers nothing would loop, so stop then
      if (res.results.length === 0) return { state: "BLOCKED", sent, code: "EMPTY_ANSWER" };
      sent += res.results.length;
    } catch (e) {
      if (e instanceof NetworkError) return { state: "OFFLINE", sent };
      if (e instanceof SessionEndedError) return { state: "SIGNED_OUT", sent };
      if (e instanceof ApiError) {
        if (e.status === 400 && batch.length > 1) {
          const moved = await oneByOne(outbox, api, batch, now);
          if (moved === null) return { state: "OFFLINE", sent };
          sent += moved;
          continue;
        }
        if (e.status === 400) {
          await outbox.acknowledge([batch[0]!.clientEventId]); // a single invalid event is dropped
          continue;
        }
        if (e.status === 401) return { state: "SIGNED_OUT", sent };
        if (e.status === 403) return { state: "BLOCKED", sent, code: e.code };
        return { state: "OFFLINE", sent }; // 429 and 5xx: later
      }
      throw e;
    }
  }
}

/** Sends the events of a refused batch one by one; drops the ones the server refuses as invalid. Null: the network is gone. */
async function oneByOne(
  outbox: Outbox,
  api: Pick<ApiClient, "postEvents">,
  batch: OutboxEvent[],
  now: () => number,
): Promise<number | null> {
  let moved = 0;
  for (const event of batch) {
    try {
      const res = await api.postEvents([toApiEvent(event, now())]);
      await outbox.acknowledge(res.results.map((r) => r.clientEventId));
      moved += 1;
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        await outbox.acknowledge([event.clientEventId]);
        continue;
      }
      if (e instanceof NetworkError || e instanceof ApiError) return moved === 0 ? null : moved;
      throw e;
    }
  }
  return moved;
}
