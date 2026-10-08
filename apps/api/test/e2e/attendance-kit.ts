import { expect } from "vitest";
import { AttendanceService } from "../../src/attendance/attendance.service";
import {
  bearer,
  createEmployeeWithUser,
  type Harness,
  setupWorld,
  signConsentSql,
  signIn,
} from "./harness";

/** Local Ulaanbaatar time is UTC+8; the work date below is Tuesday 2026-10-06. */
export const WORK_DATE = "2026-10-06";
export const at = (hhmmLocal: string) => {
  const [hh, mm] = hhmmLocal.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(2026, 9, 6, hh! - 8, mm!));
};

/** Shared fixtures for the attendance tests: a tenant with a 08:00-17:00 week, two employees with registered devices. */
export function attendanceKit(h: Harness) {
  const setClock = (hhmm: string) => {
    h.clock.current = at(hhmm);
  };
  const engine = () => h.app.get(AttendanceService);
  const tick = (tenantId: string) => engine().tickTenant(tenantId);
  const get = (token: string, url: string) => h.http().get(url).set(bearer(token));
  const post = (token: string, url: string, body: object = {}) =>
    h.http().post(url).set(bearer(token)).send(body);

  /** A tenant with a 08:00–17:00 week every day, one location, HR + admin, and a registered device for `badam`. */
  async function world() {
    setClock("07:00");
    const w = await setupWorld(h);
    await h.owner.query("SELECT seed_default_reasons($1)", [w.tenant.id]);
    const put = await h
      .http()
      .put("/v1/working-week")
      .set(bearer(w.adminTokens.accessToken))
      .send({
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          working: true,
          start: "08:00",
          end: "17:00",
        })),
      });
    expect(put.status).toBeLessThan(300);
    const locationId = (
      await h.owner.query<{ id: string }>("SELECT id FROM location WHERE tenant_id = $1", [
        w.tenant.id,
      ])
    ).rows[0]!.id;
    const register = async (token: string) => {
      const qr = (await post(w.hrTokens.accessToken, "/v1/qr/onboarding")).body;
      const res = await post(token, "/v1/devices/register", {
        qrToken: qr.token,
        platform: "ANDROID",
        attestationKeyId: `key-${Math.random().toString(36).slice(2)}`,
      });
      expect(res.status).toBe(201);
    };
    await register(w.empTokens.accessToken);
    // A second employee with their own device.
    const second = await createEmployeeWithUser(h, w.tenant, "dorj");
    await signConsentSql(h, w.tenant.id, second.employee.id);
    const secondTokens = await signIn(h, second.user);
    await register(secondTokens.accessToken);
    return {
      ...w,
      locationId,
      second,
      empRefresh: w.empTokens.refreshToken,
      secondRefresh: secondTokens.refreshToken,
      register,
    };
  }

  type W = Awaited<ReturnType<typeof world>>;
  /** Access tokens last 15 minutes of test-clock time; a phone renews them by refreshing, which keeps its device. */
  const renew = async (w: W, which: "empRefresh" | "secondRefresh") => {
    const res = await h.http().post("/v1/auth/refresh").send({ refreshToken: w[which] });
    expect(res.status).toBe(200);
    w[which] = res.body.refreshToken;
    return res.body.accessToken as string;
  };
  const emp = (w: W) => renew(w, "empRefresh");
  const second = (w: W) => renew(w, "secondRefresh");
  const ev = (w: W, over: Partial<Record<string, unknown>> = {}) => ({
    clientEventId: `evt-${Math.random().toString(36).slice(2, 12)}`,
    type: "ENTER",
    locationId: w.locationId,
    ageMs: 0,
    ...over,
  });
  const send = (token: string, events: object[]) => post(token, "/v1/events", { events });
  const resultOf = async (tenantId: string, employeeId: string) =>
    (
      await h.owner.query(
        "SELECT status, arrival_at, late_minutes, reason_name FROM attendance_result WHERE tenant_id = $1 AND employee_id = $2 AND work_date = $3",
        [tenantId, employeeId, WORK_DATE],
      )
    ).rows[0];
  const hrToken = async (w: W) => (await signIn(h, w.hr)).accessToken;

  return {
    setClock,
    engine,
    tick,
    get,
    post,
    world,
    renew,
    emp,
    second,
    ev,
    send,
    resultOf,
    hrToken,
  };
}

export type AttendanceKit = ReturnType<typeof attendanceKit>;
export type W = Awaited<ReturnType<AttendanceKit["world"]>>;
