import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import { attendanceKit } from "./attendance-kit";
import { type Harness, signIn, startHarness } from "./harness";

describe.skipIf(!hasDb)("a new login on a registered phone rejoins its device", () => {
  let h: Harness;
  let k: ReturnType<typeof attendanceKit>;
  beforeAll(async () => {
    h = await startHarness();
    k = attendanceKit(h);
  });
  afterAll(async () => {
    await h.close();
  });

  it("an unbound login is refused for events until the app proves its install key", async () => {
    const w = await k.world();
    k.setClock("08:00");
    await h.owner.query(
      "UPDATE device SET attestation_key_id = 'install-key-1' WHERE employee_id = $1 AND status = 'ACTIVE'",
      [w.employee.id],
    );

    const fresh = (await signIn(h, w.user)).accessToken;
    const refused = await k.post(fresh, "/v1/events", { events: [k.ev(w)] });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("DEVICE_REQUIRED");

    const wrong = await k.post(fresh, "/v1/devices/rebind", { attestationKeyId: "other-phone" });
    expect(wrong.body).toEqual({ bound: false });
    expect((await k.post(fresh, "/v1/events", { events: [k.ev(w)] })).status).toBe(403);

    const right = await k.post(fresh, "/v1/devices/rebind", { attestationKeyId: "install-key-1" });
    expect(right.status).toBe(200);
    expect(right.body).toEqual({ bound: true });
    expect((await k.post(fresh, "/v1/events", { events: [k.ev(w)] })).status).toBe(200);
    expect((await k.post(fresh, "/v1/heartbeat")).status).toBe(200);
  });
});
