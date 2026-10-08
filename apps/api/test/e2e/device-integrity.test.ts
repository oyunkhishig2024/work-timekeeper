import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/common/config";
import { AttestationVerifier, ConfiguredAttestationVerifier } from "../../src/devices/attestation";
import { hasDb } from "../db/helpers";
import { attendanceKit, type W } from "./attendance-kit";
import { auditActions, createUser, type Harness, signIn, startHarness } from "./harness";

const P = [
  { lat: 47.9187, lng: 106.9176 },
  { lat: 47.9201, lng: 106.9189 },
  { lat: 47.9215, lng: 106.9203 },
];

describe("ConfiguredAttestationVerifier.verifyBatch (PRD 6.7)", () => {
  const verifier = (mode: "disabled" | "enforce") =>
    new ConfiguredAttestationVerifier({ ATTESTATION_MODE: mode } as AppConfig);
  it("is off by default, demands a token when enforced, and has no real verifier yet", async () => {
    expect(await verifier("disabled").verifyBatch({ platform: "ANDROID" })).toBe("UNVERIFIED");
    expect(await verifier("enforce").verifyBatch({ platform: "ANDROID" })).toBe("FAILED");
    await expect(
      verifier("enforce").verifyBatch({ platform: "ANDROID", token: "x" }),
    ).rejects.toThrow();
  });
});

describe.skipIf(!hasDb)("batch attestation and DEVICE_CONFLICT (PRD 6.7)", () => {
  let h: Harness;
  let k: ReturnType<typeof attendanceKit>;
  beforeAll(async () => {
    h = await startHarness();
    k = attendanceKit(h);
  });
  afterAll(async () => {
    await h.close();
  });

  const hrToken = (w: W) => signIn(h, w.hr).then((t) => t.accessToken);
  /** Makes the verifier answer with `verdict` (or fail like an unreachable service) while `fn` runs. */
  async function withVerdict<T>(
    verdict: "OK" | "FAILED" | "UNAVAILABLE",
    fn: () => Promise<T>,
  ): Promise<T> {
    const verifier = h.app.get(AttestationVerifier);
    const original = verifier.verifyBatch.bind(verifier);
    verifier.verifyBatch = async () => {
      if (verdict === "UNAVAILABLE") throw new Error("Google is down");
      return verdict;
    };
    try {
      return await fn();
    } finally {
      verifier.verifyBatch = original;
    }
  }
  const sendBatch = async (w: W, extra: object = {}, event: object = {}) =>
    k.post(await k.emp(w), "/v1/events", { events: [k.ev(w, event)], ...extra });
  const deviceRow = async (w: W) =>
    (
      await h.owner.query(
        "SELECT attestation_unavailable_streak AS streak, last_batch_verdict AS verdict FROM device WHERE employee_id = $1 AND status = 'ACTIVE'",
        [w.employee.id],
      )
    ).rows[0];

  describe("attestation", () => {
    it("with attestation switched off nothing is flagged and nothing is counted", async () => {
      const w = await k.world();
      k.setClock("07:00");
      const res = await sendBatch(w);
      expect(res.body.results[0].flags).toEqual([]);
      expect(await deviceRow(w)).toMatchObject({ streak: 0, verdict: null });
    });

    it("an OK verdict leaves no flag and is recorded on the device", async () => {
      const w = await k.world();
      k.setClock("07:00");
      const res = await withVerdict("OK", () => sendBatch(w));
      expect(res.body.results[0].flags).toEqual([]);
      expect(await deviceRow(w)).toMatchObject({ streak: 0, verdict: "OK" });
    });

    it("a FAILED verdict is accepted and counts, but every event is flagged and queued for HR", async () => {
      const w = await k.world();
      k.setClock("08:00");
      const res = await withVerdict("FAILED", () => sendBatch(w));
      expect(res.body.results[0]).toMatchObject({ counted: true, flags: ["ATTESTATION_FAILED"] });
      k.setClock("08:05");
      await k.tick(w.tenant.id);
      expect(await k.resultOf(w.tenant.id, w.employee.id)).toMatchObject({ status: "ON_TIME" });
      const hr = await hrToken(w);
      const item = (await k.get(hr, "/v1/attendance/anomalies")).body.items[0];
      expect(item).toMatchObject({ flags: ["ATTESTATION_FAILED"], reviewStatus: "PENDING" });
      await k.post(hr, `/v1/attendance/anomalies/${item.id}/review`, {
        decision: "REJECT",
        note: "Эмулятор",
      });
      expect((await k.resultOf(w.tenant.id, w.employee.id)).status).toBe("PENDING");
    });

    it("an unreachable verdict service never blocks attendance: UNAVAILABLE is noted, not queued", async () => {
      const w = await k.world();
      k.setClock("08:00");
      const res = await withVerdict("UNAVAILABLE", () => sendBatch(w));
      expect(res.body.results[0]).toMatchObject({
        outcome: "ACCEPTED",
        counted: true,
        flags: ["ATTESTATION_UNAVAILABLE"],
      });
      expect((await k.get(await hrToken(w), "/v1/attendance/anomalies")).body.total).toBe(0);
      expect(await deviceRow(w)).toMatchObject({ streak: 1, verdict: "UNAVAILABLE" });
    });

    it("five unavailable verdicts in a row open one alert for HR; a given verdict resets the run", async () => {
      const w = await k.world();
      const alerts = async () => (await k.get(await hrToken(w), "/v1/device-alerts")).body;
      k.setClock("08:00");
      for (let i = 0; i < 4; i++) await withVerdict("UNAVAILABLE", () => sendBatch(w));
      expect((await alerts()).total).toBe(0);
      await withVerdict("UNAVAILABLE", () => sendBatch(w));
      const open = await alerts();
      expect(open.total).toBe(1);
      expect(open.items[0]).toMatchObject({
        kind: "ATTESTATION_UNAVAILABLE_STREAK",
        employeeId: w.employee.id,
        unavailableStreak: 5,
        resolvedAt: null,
      });
      await withVerdict("UNAVAILABLE", () => sendBatch(w));
      expect((await alerts()).total).toBe(1); // the sixth does not open another

      await withVerdict("OK", () => sendBatch(w));
      expect(await deviceRow(w)).toMatchObject({ streak: 0 });
      // Resolve, then a new run of five opens a new alert.
      const hr = await hrToken(w);
      const resolved = await k.post(hr, `/v1/device-alerts/${open.items[0].id}/resolve`, {
        note: "Google асуудал",
      });
      expect(resolved.body).toMatchObject({
        resolvedByName: "hr",
        resolutionNote: "Google асуудал",
      });
      expect((await k.post(hr, `/v1/device-alerts/${open.items[0].id}/resolve`)).status).toBe(409);
      expect((await alerts()).total).toBe(0);
      expect((await k.get(hr, "/v1/device-alerts?status=ALL")).body.total).toBe(1);
      expect(await auditActions(h, w.tenant.id)).toContain("device.alert_resolved");
      for (let i = 0; i < 5; i++) await withVerdict("UNAVAILABLE", () => sendBatch(w));
      expect((await alerts()).total).toBe(1);
    });
  });

  describe("DEVICE_CONFLICT", () => {
    const keyOf = async (w: W) =>
      (
        await h.owner.query<{ k: string }>(
          "SELECT attestation_key_id AS k FROM device WHERE employee_id = $1 AND status = 'ACTIVE'",
          [w.employee.id],
        )
      ).rows[0]!.k;

    it("a batch signed by the registered install key is fine; another key is a conflict with an alert", async () => {
      const w = await k.world();
      k.setClock("07:05");
      expect(
        (await sendBatch(w, { attestationKeyId: await keyOf(w) })).body.results[0].flags,
      ).toEqual([]);
      const bad = await sendBatch(w, { attestationKeyId: "some-other-install-key" });
      expect(bad.body.results[0]).toMatchObject({ counted: true, flags: ["DEVICE_CONFLICT"] });
      const hr = await hrToken(w);
      const alerts = (await k.get(hr, "/v1/device-alerts?kind=DEVICE_CONFLICT")).body;
      expect(alerts.items).toEqual([
        expect.objectContaining({ employeeId: w.employee.id, relatedEmployeeId: null }),
      ]);
      expect((await k.get(hr, "/v1/attendance/anomalies")).body.items[0].flags).toEqual([
        "DEVICE_CONFLICT",
      ]);
      // The same problem again does not open a second alert.
      await sendBatch(w, { attestationKeyId: "some-other-install-key" });
      expect((await k.get(hr, "/v1/device-alerts")).body.total).toBe(1);
    });

    it("using another employee's device key names that employee", async () => {
      const w = await k.world();
      k.setClock("07:05");
      const res = await sendBatch(w, {
        attestationKeyId: await keyOf({ ...w, employee: w.second.employee } as W),
      });
      expect(res.body.results[0].flags).toEqual(["DEVICE_CONFLICT"]);
      const items = (await k.get(await hrToken(w), "/v1/device-alerts")).body.items;
      expect(items[0]).toMatchObject({
        employeeId: w.employee.id,
        relatedEmployeeId: w.second.employee.id,
      });
    });

    const fixAt = (w: W, p: { lat: number; lng: number }, over: object = {}) =>
      k.ev(w, { ...p, ...over });
    /** Both employees report the same place at the same minute, three times in a row. */
    async function walkTogether(w: W, places: Array<{ lat: number; lng: number }>) {
      const flags: string[][] = [];
      const times = ["07:00", "07:05", "07:10"];
      for (let i = 0; i < places.length; i++) {
        k.setClock(times[i]!);
        await k.send(await k.emp(w), [fixAt(w, places[i]!, { type: "EXIT" })]);
        const res = await k.send(await k.second(w), [fixAt(w, places[i]!, { type: "EXIT" })]);
        flags.push(res.body.results[0].flags);
      }
      return flags;
    }

    it("identical coordinates and movement as another employee, three times: the third fix is flagged and one alert opens", async () => {
      const w = await k.world();
      expect(await walkTogether(w, P)).toEqual([[], [], ["DEVICE_CONFLICT"]]);
      const hr = await hrToken(w);
      const items = (await k.get(hr, "/v1/device-alerts?kind=DEVICE_CONFLICT")).body.items;
      expect(items).toHaveLength(1);
      expect(new Set([items[0].employeeId, items[0].relatedEmployeeId])).toEqual(
        new Set([w.employee.id, w.second.employee.id]),
      );
      const queue = (await k.get(hr, "/v1/attendance/anomalies")).body.items;
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({
        flags: ["DEVICE_CONFLICT"],
        employeeId: w.second.employee.id,
      });
    });

    it("coincidences at one single place, or places 20 m apart, are not a conflict", async () => {
      const w = await k.world();
      expect(await walkTogether(w, [P[0]!, P[0]!, P[0]!])).toEqual([[], [], []]);
      const w2 = await k.world();
      const near = P.map((p) => ({ lat: p.lat, lng: p.lng }));
      // The second employee is about 20 m away at every fix.
      const flags: string[][] = [];
      for (let i = 0; i < 3; i++) {
        k.setClock(["07:00", "07:05", "07:10"][i]!);
        await k.send(await k.emp(w2), [fixAt(w2, near[i]!, { type: "EXIT" })]);
        const res = await k.send(await k.second(w2), [
          fixAt(w2, { lat: near[i]!.lat + 0.0002, lng: near[i]!.lng }, { type: "EXIT" }),
        ]);
        flags.push(res.body.results[0].flags);
      }
      expect(flags).toEqual([[], [], []]);
    });

    it("employees of different tenants never conflict, and Manager cannot read alerts", async () => {
      const a = await k.world();
      const b = await k.world();
      for (let i = 0; i < 3; i++) {
        k.setClock(["07:00", "07:05", "07:10"][i]!);
        await k.send(await k.emp(a), [fixAt(a, P[i]!, { type: "EXIT" })]);
        const res = await k.send(await k.emp(b), [fixAt(b, P[i]!, { type: "EXIT" })]);
        expect(res.body.results[0].flags).toEqual([]);
      }
      const mgr = (
        await signIn(h, await createUser(h, a.tenant, { username: "mgr", role: "MANAGER" }))
      ).accessToken;
      expect((await k.get(mgr, "/v1/device-alerts")).status).toBe(403);
    });
  });
});
