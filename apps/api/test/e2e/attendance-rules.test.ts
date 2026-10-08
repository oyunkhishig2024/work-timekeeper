import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIn } from "../../src/common/dates";
import { hasDb } from "../db/helpers";
import {
  auditActions,
  bearer,
  createTenant,
  createUser,
  type Harness,
  signIn,
  startHarness,
} from "./harness";

describe.skipIf(!hasDb)("attendance rule versions (PRD 6.2–6.4, 13, 22.1)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const today = () => todayIn("Asia/Ulaanbaatar", h.clock.now());
  const addDays = (date: string, n: number) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const put = (token: string, url: string, body: object) =>
    h.http().put(url).set(bearer(token)).send(body);
  const post = (token: string, url: string, body: object = {}) =>
    h.http().post(url).set(bearer(token)).send(body);
  const get = (token: string, url: string) => h.http().get(url).set(bearer(token));
  const rules = (o: Partial<Record<string, number | string | null>> = {}) => ({
    graceMinutes: 15,
    cutoffMinutes: 120,
    minStayMinutes: 3,
    earlyWindowMinutes: 120,
    ...o,
  });

  async function world() {
    const tenant = await createTenant(h);
    const admin = (
      await signIn(
        h,
        await createUser(h, tenant, { username: "admin", role: "ORG_ADMIN", totp: true }),
      )
    ).accessToken;
    const hr = (
      await signIn(h, await createUser(h, tenant, { username: "hr", role: "HR", totp: true }))
    ).accessToken;
    const mgr = (await signIn(h, await createUser(h, tenant, { username: "mgr", role: "MANAGER" })))
      .accessToken;
    const loc = async (name: string) =>
      (await post(admin, "/v1/locations", { name, lat: 47.9, lng: 106.9, radiusM: 150 })).body
        .id as string;
    return { tenant, admin, hr, mgr, central: await loc("Төв салбар"), emma: await loc("ЭМАА") };
  }

  it("falls back to the PRD defaults until the Org Admin saves rules; only the Org Admin changes them", async () => {
    const w = await world();
    const none = await get(w.mgr, "/v1/attendance-rules");
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({
      source: "DEFAULT",
      graceMinutes: 15,
      cutoffMinutes: 120,
      minStayMinutes: 3,
      earlyWindowMinutes: 120,
      id: null,
    });
    expect((await put(w.hr, "/v1/attendance-rules", rules())).status).toBe(403);
    expect((await put(w.mgr, "/v1/attendance-rules", rules())).status).toBe(403);
    expect((await h.http().put("/v1/attendance-rules").send(rules())).status).toBe(401);

    const saved = await put(
      w.admin,
      "/v1/attendance-rules",
      rules({ graceMinutes: 10, cutoffMinutes: 90 }),
    );
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      locationId: null,
      validFrom: today(),
      validTo: null,
      graceMinutes: 10,
      cutoffMinutes: 90,
    });
    const read = await get(w.hr, "/v1/attendance-rules");
    expect(read.body).toMatchObject({ source: "TENANT", graceMinutes: 10, cutoffMinutes: 90 });
    expect(await auditActions(h, w.tenant.id)).toContain("attendance_rules.changed");
  });

  it("validates ranges", async () => {
    const w = await world();
    const bad = async (o: object) => (await put(w.admin, "/v1/attendance-rules", rules(o))).status;
    expect(await bad({ graceMinutes: -1 })).toBe(400);
    expect(await bad({ graceMinutes: 241 })).toBe(400);
    expect(await bad({ cutoffMinutes: 1441 })).toBe(400);
    expect(await bad({ minStayMinutes: 0 })).toBe(400);
    expect(await bad({ minStayMinutes: 16 })).toBe(400);
    expect(await bad({ earlyWindowMinutes: 721 })).toBe(400);
    expect(await bad({ graceMinutes: 1.5 })).toBe(400);
    expect(await bad({ effectiveFrom: "2026-02-30" })).toBe(400);
    expect(await bad({ bogus: 1 })).toBe(400);
    expect((await put(w.admin, "/v1/attendance-rules", { graceMinutes: 15 })).status).toBe(400);
    expect(
      await bad({ graceMinutes: 0, cutoffMinutes: 0, minStayMinutes: 1, earlyWindowMinutes: 0 }),
    ).toBe(200);
  });

  it("new rules apply from their date; the past is not rewritten; unstarted versions are replaced", async () => {
    const w = await world();
    await put(w.admin, "/v1/attendance-rules", rules());
    const past = await put(
      w.admin,
      "/v1/attendance-rules",
      rules({ effectiveFrom: addDays(today(), -1) }),
    );
    expect(past.status).toBe(400);
    expect(past.body.code).toBe("EFFECTIVE_DATE_IN_PAST");
    expect((await put(w.admin, "/v1/attendance-rules", rules())).body.code).toBe(
      "EFFECTIVE_DATE_NOT_AFTER_CURRENT",
    );

    const from = addDays(today(), 14);
    expect(
      (await put(w.admin, "/v1/attendance-rules", rules({ graceMinutes: 30, effectiveFrom: from })))
        .status,
    ).toBe(200);
    expect((await get(w.hr, "/v1/attendance-rules")).body.graceMinutes).toBe(15);
    expect((await get(w.hr, `/v1/attendance-rules?asOf=${from}`)).body.graceMinutes).toBe(30);
    expect(
      (await get(w.hr, `/v1/attendance-rules?asOf=${addDays(from, -1)}`)).body.graceMinutes,
    ).toBe(15);
    // replace the one that has not started
    await put(
      w.admin,
      "/v1/attendance-rules",
      rules({ graceMinutes: 20, effectiveFrom: addDays(today(), 7) }),
    );
    const versions = (await get(w.hr, "/v1/attendance-rules/versions")).body;
    expect(
      versions.map((v: { validFrom: string; graceMinutes: number }) => [
        v.validFrom,
        v.graceMinutes,
      ]),
    ).toEqual([
      [addDays(today(), 7), 20],
      [today(), 15],
    ]);
    expect(versions[1].validTo).toBe(addDays(today(), 7));
    expect(versions[0].validTo).toBeNull();
  });

  it("a location can have its own rules and go back to the tenant rules", async () => {
    const w = await world();
    await put(w.admin, "/v1/attendance-rules", rules());
    expect((await get(w.hr, `/v1/attendance-rules?locationId=${w.emma}`)).body.source).toBe(
      "TENANT",
    );
    const own = await put(
      w.admin,
      "/v1/attendance-rules",
      rules({ locationId: w.emma, graceMinutes: 5, cutoffMinutes: 60 }),
    );
    expect(own.status).toBe(200);
    expect((await get(w.hr, `/v1/attendance-rules?locationId=${w.emma}`)).body).toMatchObject({
      source: "LOCATION",
      graceMinutes: 5,
      cutoffMinutes: 60,
    });
    expect((await get(w.hr, `/v1/attendance-rules?locationId=${w.central}`)).body.source).toBe(
      "TENANT",
    );
    expect((await get(w.hr, "/v1/attendance-rules")).body.graceMinutes).toBe(15);
    expect(
      (await get(w.hr, "/v1/attendance-rules/versions?locationId=" + w.emma)).body,
    ).toHaveLength(1);
    expect(
      (
        await put(
          w.admin,
          "/v1/attendance-rules",
          rules({ locationId: "00000000-0000-4000-8000-000000000000" }),
        )
      ).status,
    ).toBe(404);

    const back = await post(w.admin, "/v1/attendance-rules/inherit", {
      locationId: w.emma,
      effectiveFrom: addDays(today(), 1),
    });
    expect(back.status).toBe(200);
    expect((await get(w.hr, `/v1/attendance-rules?locationId=${w.emma}`)).body.source).toBe(
      "LOCATION",
    ); // still today
    expect(
      (await get(w.hr, `/v1/attendance-rules?locationId=${w.emma}&asOf=${addDays(today(), 1)}`))
        .body.source,
    ).toBe("TENANT");
    expect(
      (await post(w.admin, "/v1/attendance-rules/inherit", { locationId: w.central })).body.code,
    ).toBe("LOCATION_NOT_OVERRIDDEN");
    expect(await auditActions(h, w.tenant.id)).toContain("attendance_rules.override_removed");
  });
});
