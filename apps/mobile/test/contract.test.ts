import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/lib/api";
import { Outbox } from "../src/services/outbox";
import { flushOutbox } from "../src/services/sync";
import { MemoryStore, MemoryTokens } from "./helpers";

/**
 * The app's client, outbox and uploader against a REAL API (not a fake). Skipped unless the environment names one:
 *   TKW_E2E_URL, TKW_E2E_ORG, TKW_E2E_USER, TKW_E2E_PASSWORD, TKW_E2E_QR (a fresh onboarding QR token), TKW_E2E_LOCATION
 * `apps/mobile/README.md` explains how the API side is started.
 */
const env = process.env;
const enabled = Boolean(
  env.TKW_E2E_URL && env.TKW_E2E_ORG && env.TKW_E2E_USER && env.TKW_E2E_PASSWORD,
);

describe.skipIf(!enabled)("the app against the real API", () => {
  it("signs in, registers the phone, reads the plan, uploads events and sees the day", async () => {
    const tokens = new MemoryTokens();
    const api = new ApiClient({ baseUrl: env.TKW_E2E_URL!, tokens });
    const login = await api.login(env.TKW_E2E_ORG!, env.TKW_E2E_USER!, env.TKW_E2E_PASSWORD!);
    expect(login.status).toBe("OK");
    if (login.status !== "OK") return;
    expect(login.auth.requires).toEqual([]);
    expect((await api.me()).role).toBeTruthy();

    // not registered yet: no active phone
    expect((await api.myDevice()).device).toBeNull();
    await api.registerDevice({
      qrToken: env.TKW_E2E_QR!,
      platform: "ANDROID",
      model: "Test phone",
      appVersion: "0.1.0",
      attestationKeyId: `key-${Math.random().toString(36).slice(2)}`,
    });
    expect((await api.myDevice()).device?.status).toBe("ACTIVE");

    // the plan names the places to watch
    const plan = await api.plan();
    expect(plan.days).toHaveLength(3);
    expect(plan.places.map((p) => p.id)).toContain(env.TKW_E2E_LOCATION);

    // an ENTER captured a few minutes ago is uploaded; the server works the arrival time out from the age
    const outbox = new Outbox(new MemoryStore());
    await outbox.enqueue({
      clientEventId: `evt-${Math.random().toString(36).slice(2, 12)}`,
      type: "ENTER",
      locationId: env.TKW_E2E_LOCATION!,
      capturedAt: Date.now() - 5 * 60_000,
      lat: 47.9,
      lng: 106.9,
      accuracyM: 12,
    });
    expect(await flushOutbox(outbox, api)).toEqual({ state: "DONE", sent: 1 });
    expect(await outbox.size()).toBe(0);
    await api.heartbeat();

    // retrying the same upload is harmless (idempotent): nothing is left to send
    expect((await flushOutbox(outbox, api)).state).toBe("EMPTY");

    // the history of the month carries a summary
    const today = plan.days[0]!.date;
    const history = await api.myAttendance(today, today);
    expect(history.summary).toBeTruthy();
    await api.logout();
    expect(tokens.value).toBeNull();
  });
});
