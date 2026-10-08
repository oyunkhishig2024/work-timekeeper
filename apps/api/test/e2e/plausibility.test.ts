import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import { attendanceKit, WORK_DATE, type W } from "./attendance-kit";
import { type Harness, signIn, startHarness } from "./harness";

const HERE = { lat: 47.9187, lng: 106.9176 };
/** About 11.1 km north of HERE. */
const FAR = { lat: HERE.lat + 0.1, lng: HERE.lng };

describe.skipIf(!hasDb)("impossible-speed check on event coordinates (PRD 6.7)", () => {
  let h: Harness;
  let k: ReturnType<typeof attendanceKit>;
  beforeAll(async () => {
    h = await startHarness();
    k = attendanceKit(h);
  });
  afterAll(async () => {
    await h.close();
  });

  const fix = (w: W, pos: { lat: number; lng: number }, over: Record<string, unknown> = {}) =>
    k.ev(w, { ...pos, ...over });
  const flagsOf = async (w: W) =>
    (
      await h.owner.query<{ flags: string[]; counted: boolean }>(
        "SELECT flags, counted FROM device_event WHERE employee_id = $1 ORDER BY occurred_at, created_at",
        [w.employee.id],
      )
    ).rows;
  const hrToken = (w: W) => signIn(h, w.hr).then((t) => t.accessToken);

  it("11 km in 4 minutes is flagged IMPOSSIBLE_SPEED, accepted and queued; 11 km in 5 minutes is plausible", async () => {
    const w = await k.world();
    k.setClock("07:00");
    expect(
      (await k.send(await k.emp(w), [fix(w, FAR, { type: "EXIT" })])).body.results[0].flags,
    ).toEqual([]);
    k.setClock("07:04");
    const bad = await k.send(await k.emp(w), [fix(w, HERE)]);
    expect(bad.body.results[0]).toMatchObject({
      outcome: "ACCEPTED",
      counted: true,
      flags: ["IMPOSSIBLE_SPEED"],
    });
    const queue = await k.get(await hrToken(w), "/v1/attendance/anomalies");
    expect(queue.body.items[0]).toMatchObject({
      flags: ["IMPOSSIBLE_SPEED"],
      lat: HERE.lat,
      lng: HERE.lng,
    });

    const w2 = await k.world();
    k.setClock("07:00");
    await k.send(await k.emp(w2), [fix(w2, FAR, { type: "EXIT" })]);
    k.setClock("07:05");
    expect((await k.send(await k.emp(w2), [fix(w2, HERE)])).body.results[0].flags).toEqual([]);
  });

  it("each fix is compared with the nearest previous fix, not with the first one of the day", async () => {
    const w = await k.world();
    k.setClock("07:00");
    await k.send(await k.emp(w), [fix(w, FAR, { type: "EXIT" })]);
    k.setClock("07:10");
    expect((await k.send(await k.emp(w), [fix(w, HERE)])).body.results[0].flags).toEqual([]);
    // Back at the first place 4 minutes later: fine against the first fix, impossible against the previous one.
    k.setClock("07:14");
    expect(
      (await k.send(await k.emp(w), [fix(w, FAR, { type: "EXIT" })])).body.results[0].flags,
    ).toEqual(["IMPOSSIBLE_SPEED"]);
  });

  it("an offline batch is checked in time order, whatever order it arrives in", async () => {
    const w = await k.world();
    k.setClock("07:30");
    // 30 min ago far away, 26 min ago here (4 min later: impossible), listed newest first.
    const res = await k.send(await k.emp(w), [
      fix(w, HERE, { clientEventId: "evt-batch-new", ageMs: 26 * 60_000 }),
      fix(w, FAR, { clientEventId: "evt-batch-old", type: "EXIT", ageMs: 30 * 60_000 }),
    ]);
    const byId = Object.fromEntries(
      res.body.results.map((r: { clientEventId: string; flags: string[] }) => [
        r.clientEventId,
        r.flags,
      ]),
    );
    expect(byId).toEqual({ "evt-batch-old": [], "evt-batch-new": ["IMPOSSIBLE_SPEED"] });
  });

  it("a fix is also compared with the next stored fix (a late-synced older event)", async () => {
    const w = await k.world();
    k.setClock("07:30");
    await k.send(await k.emp(w), [fix(w, HERE, { clientEventId: "evt-later" })]);
    // Arrives afterwards, but happened 4 minutes before the one above, 11 km away.
    k.setClock("07:31");
    const res = await k.send(await k.emp(w), [
      fix(w, FAR, { clientEventId: "evt-earlier", type: "EXIT", ageMs: 5 * 60_000 }),
    ]);
    expect(res.body.results[0].flags).toEqual(["IMPOSSIBLE_SPEED"]);
  });

  it("accuracy radii are taken into account: imprecise fixes a little apart are not a teleport", async () => {
    const w = await k.world();
    k.setClock("07:30");
    await k.send(await k.emp(w), [fix(w, HERE, { type: "EXIT", accuracyM: 300 })]);
    k.setClock("07:30");
    const near = { lat: HERE.lat + 0.005, lng: HERE.lng };
    const res = await k.send(await k.emp(w), [fix(w, near, { type: "EXIT", accuracyM: 300 })]);
    expect(res.body.results[0].flags).toEqual([]);
  });

  it("mock, flagged and rejected fixes are not used as the reference", async () => {
    const w = await k.world();
    k.setClock("07:00");
    // A mock fix far away must not make the real fix 4 minutes later "impossible".
    await k.send(await k.emp(w), [fix(w, FAR, { type: "EXIT", mockLocation: true })]);
    k.setClock("07:04");
    expect((await k.send(await k.emp(w), [fix(w, HERE)])).body.results[0].flags).toEqual([]);
    // A fix already flagged for speed is not a reference either.
    k.setClock("07:06");
    const jump = await k.send(await k.emp(w), [fix(w, FAR, { type: "EXIT" })]);
    expect(jump.body.results[0].flags).toEqual(["IMPOSSIBLE_SPEED"]);
    k.setClock("07:10");
    expect((await k.send(await k.emp(w), [fix(w, HERE)])).body.results[0].flags).toEqual([]);
    expect((await flagsOf(w)).map((r) => r.flags)).toEqual([
      ["MOCK_LOCATION"],
      [],
      ["IMPOSSIBLE_SPEED"],
      [],
    ]);
  });

  it("events without coordinates are never flagged for speed, and coordinates are validated", async () => {
    const w = await k.world();
    k.setClock("07:00");
    await k.send(await k.emp(w), [fix(w, FAR, { type: "EXIT" })]);
    k.setClock("07:01");
    expect((await k.send(await k.emp(w), [k.ev(w)])).body.results[0].flags).toEqual([]);
    const post = async (extra: object) => k.send(await k.emp(w), [k.ev(w, extra)]);
    expect((await post({ lat: 47.9 })).status).toBe(400);
    expect((await post({ lat: 91, lng: 10 })).status).toBe(400);
    expect((await post({ lat: 10, lng: 181 })).status).toBe(400);
  });

  it("Reject on a teleport removes the arrival it produced; the day is rebuilt", async () => {
    const w = await k.world();
    k.setClock("07:50");
    await k.send(await k.emp(w), [fix(w, FAR, { type: "EXIT" })]);
    k.setClock("07:54");
    await k.send(await k.emp(w), [fix(w, HERE)]);
    k.setClock("08:00");
    await k.tick(w.tenant.id);
    expect(await k.resultOf(w.tenant.id, w.employee.id)).toMatchObject({ status: "ON_TIME" });
    const hr = await hrToken(w);
    const item = (await k.get(hr, "/v1/attendance/anomalies")).body.items[0];
    const res = await k.post(hr, `/v1/attendance/anomalies/${item.id}/review`, {
      decision: "REJECT",
      note: "Нэг дор хоёр газар байх боломжгүй",
    });
    expect(res.body).toMatchObject({ reviewStatus: "REJECTED", counted: false });
    expect(await k.resultOf(w.tenant.id, w.employee.id)).toMatchObject({ status: "PENDING" });
    k.setClock("17:00");
    await k.tick(w.tenant.id);
    expect(await k.resultOf(w.tenant.id, w.employee.id)).toMatchObject({ status: "NO_SHOW" });
    expect(WORK_DATE).toBe("2026-10-06");
  });

  it("raw coordinates are erased after 30 days; the event and its flags stay", async () => {
    const w = await k.world();
    k.setClock("07:00");
    await k.send(await k.emp(w), [fix(w, FAR, { type: "EXIT" })]);
    k.setClock("07:04");
    await k.send(await k.emp(w), [fix(w, HERE)]);
    // The first event is 31 days old, the second is recent.
    await h.owner.query(
      "UPDATE device_event SET received_at = received_at - interval '31 days' WHERE employee_id = $1 AND type = 'EXIT'",
      [w.employee.id],
    );
    const erased = await k.engine().eraseOldCoordinates();
    expect(erased).toBeGreaterThanOrEqual(1);
    const rows = await h.owner.query(
      "SELECT type, lat, lng, coordinates_erased_at, flags FROM device_event WHERE employee_id = $1 ORDER BY occurred_at",
      [w.employee.id],
    );
    expect(rows.rows[0]).toMatchObject({ type: "EXIT", lat: null, lng: null });
    expect(rows.rows[0].coordinates_erased_at).not.toBeNull();
    expect(rows.rows[1]).toMatchObject({
      type: "ENTER",
      lat: HERE.lat,
      flags: ["IMPOSSIBLE_SPEED"],
    });
    expect(rows.rows[1].coordinates_erased_at).toBeNull();
    expect(await k.engine().eraseOldCoordinates()).toBe(0);
  });
});
