import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import { attendanceKit } from "./attendance-kit";
import { type Harness, startHarness } from "./harness";

/** Cost control: a phone (or a stolen login) cannot flood /events or /heartbeat. */
describe.skipIf(!hasDb)("limits on what a phone may send", () => {
  let h: Harness;
  let k: ReturnType<typeof attendanceKit>;
  const saved = { ...process.env };
  beforeAll(async () => {
    process.env.DEVICE_EVENT_CALLS_PER_MINUTE = "3";
    process.env.DEVICE_HEARTBEATS_PER_MINUTE = "2";
    h = await startHarness();
    k = attendanceKit(h);
  });
  afterAll(async () => {
    await h.close();
    for (const key of ["DEVICE_EVENT_CALLS_PER_MINUTE", "DEVICE_HEARTBEATS_PER_MINUTE"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("refuses the call over the limit with 429 and Retry-After, leaves others alone, and recovers", async () => {
    const w = await k.world();
    k.setClock("08:10");
    const token = await k.emp(w);
    const other = await k.second(w);
    const call = () =>
      h
        .http()
        .post("/v1/events")
        .set("Authorization", `Bearer ${token}`)
        .send({ events: [k.ev(w)] });

    for (let i = 0; i < 3; i += 1) expect((await call()).status).toBe(200);
    const refused = await call();
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe("DEVICE_RATE_LIMITED");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(refused.body.retryAfterSeconds).toBeGreaterThan(0);

    // a colleague's phone is not affected
    expect((await k.send(other, [k.ev(w)])).status).toBe(200);

    // the next minute it works again
    h.clock.advanceSeconds(61);
    expect((await call()).status).toBe(200);
  });

  it("limits heartbeats the same way", async () => {
    const w = await k.world();
    k.setClock("08:10");
    const token = await k.emp(w);
    const beat = () => h.http().post("/v1/heartbeat").set("Authorization", `Bearer ${token}`);
    expect((await beat()).status).toBe(200);
    expect((await beat()).status).toBe(200);
    const refused = await beat();
    expect([refused.status, refused.body.code]).toEqual([429, "DEVICE_RATE_LIMITED"]);
  });
});
