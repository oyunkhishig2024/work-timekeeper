import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import {
  bearer,
  createEmployeeWithUser,
  createTenant,
  createUser,
  type Harness,
  startHarness,
  type TokenBody,
} from "./harness";

const WEB = { "X-TK-Client": "web" };

/** The tk_rt cookie of a response: its value and the full Set-Cookie line. */
function refreshCookie(res: {
  headers: Record<string, unknown>;
}): { value: string; line: string } | null {
  const lines = ([] as string[]).concat(
    (res.headers["set-cookie"] as string[] | string | undefined) ?? [],
  );
  const line = lines.find((l) => l.startsWith("tk_rt="));
  return line ? { value: line.slice("tk_rt=".length).split(";")[0]!, line } : null;
}

// The web app keeps the refresh token in an httpOnly cookie; the phone app keeps using the JSON body. Web staff sessions also
// end STAFF_SESSION_MAX_HOURS after sign-in however active they are. (Set to 1 hour here so a test can reach it.)
describe.skipIf(!hasDb)("refresh token cookie and the maximum staff session age", () => {
  let h: Harness;
  const previous = process.env.STAFF_SESSION_MAX_HOURS;
  beforeAll(async () => {
    process.env.STAFF_SESSION_MAX_HOURS = "1";
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
    if (previous === undefined) delete process.env.STAFF_SESSION_MAX_HOURS;
    else process.env.STAFF_SESSION_MAX_HOURS = previous;
  });

  const webLogin = async (user: { orgCode: string; username: string; password: string }) =>
    h
      .http()
      .post("/v1/auth/login")
      .set(WEB)
      .send({ orgCode: user.orgCode, username: user.username, password: user.password });

  it("web sign-in: the token is in an httpOnly SameSite=Strict cookie and not in the body", async () => {
    const tenant = await createTenant(h);
    const user = await createUser(h, tenant, { username: "mgr", role: "MANAGER" });

    const res = await webLogin(user);
    expect(res.status).toBe(200);
    expect(res.body.tokens.accessToken).toBeTruthy();
    expect(res.body.tokens).not.toHaveProperty("refreshToken");
    expect(JSON.stringify(res.body)).not.toContain(refreshCookie(res)!.value);

    const cookie = refreshCookie(res)!;
    expect(cookie.line).toContain("HttpOnly");
    expect(cookie.line).toContain("SameSite=Strict");
    expect(cookie.line).toContain("Path=/v1/auth");
    expect(cookie.line).not.toContain("Max-Age"); // a session cookie
    expect(cookie.line).not.toContain("Secure"); // plain HTTP in this test
  });

  it("is Secure when the browser used HTTPS (the proxy says so)", async () => {
    const tenant = await createTenant(h);
    const user = await createUser(h, tenant, { username: "mgr", role: "MANAGER" });
    const res = await h
      .http()
      .post("/v1/auth/login")
      .set(WEB)
      .set("X-Forwarded-Proto", "https")
      .send({ orgCode: user.orgCode, username: user.username, password: user.password });
    expect(refreshCookie(res)!.line).toContain("Secure");
  });

  it("the phone (no client header) still gets the token in the body and no cookie", async () => {
    const tenant = await createTenant(h);
    const user = await createUser(h, tenant, { username: "mgr", role: "MANAGER" });
    const res = await h
      .http()
      .post("/v1/auth/login")
      .send({ orgCode: user.orgCode, username: user.username, password: user.password });
    expect((res.body.tokens as TokenBody).refreshToken).toBeTruthy();
    expect(refreshCookie(res)).toBeNull();

    const next = await h
      .http()
      .post("/v1/auth/refresh")
      .send({ refreshToken: (res.body.tokens as TokenBody).refreshToken });
    expect(next.status).toBe(200);
    expect(next.body.refreshToken).toBeTruthy();
    expect(refreshCookie(next)).toBeNull();
  });

  it("refreshes from the cookie, rotates it, and a replayed old cookie ends the login", async () => {
    const tenant = await createTenant(h);
    const user = await createUser(h, tenant, { username: "mgr", role: "MANAGER" });
    const first = refreshCookie(await webLogin(user))!;

    const refreshed = await h
      .http()
      .post("/v1/auth/refresh")
      .set(WEB)
      .set("Cookie", `tk_rt=${first.value}`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toBeTruthy();
    expect(refreshed.body).not.toHaveProperty("refreshToken");
    const second = refreshCookie(refreshed)!;
    expect(second.value).not.toBe(first.value);

    h.clock.advanceSeconds(6 * 60); // beyond the grace for a retry: this is a replay
    const replay = await h
      .http()
      .post("/v1/auth/refresh")
      .set(WEB)
      .set("Cookie", `tk_rt=${first.value}`);
    expect(replay.status).toBe(401);
    expect(refreshCookie(replay)!.line).toContain("Max-Age=0"); // the dead cookie is removed
    const afterTheft = await h
      .http()
      .post("/v1/auth/refresh")
      .set(WEB)
      .set("Cookie", `tk_rt=${second.value}`);
    expect(afterTheft.status).toBe(401); // the whole family is revoked
  });

  it("refuses the cookie without the client header, and answers 401 without any token", async () => {
    const tenant = await createTenant(h);
    const user = await createUser(h, tenant, { username: "mgr", role: "MANAGER" });
    const cookie = refreshCookie(await webLogin(user))!;

    const noHeader = await h.http().post("/v1/auth/refresh").set("Cookie", `tk_rt=${cookie.value}`);
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.code).toBe("CLIENT_HEADER_REQUIRED");

    const nothing = await h.http().post("/v1/auth/refresh").set(WEB);
    expect(nothing.status).toBe(401);

    // the refused cross-site style request did not use up the session
    const ok = await h
      .http()
      .post("/v1/auth/refresh")
      .set(WEB)
      .set("Cookie", `tk_rt=${cookie.value}`);
    expect(ok.status).toBe(200);
  });

  it("sign-out removes the cookie and ends the session", async () => {
    const tenant = await createTenant(h);
    const user = await createUser(h, tenant, { username: "mgr", role: "MANAGER" });
    const res = await webLogin(user);
    const cookie = refreshCookie(res)!;

    const out = await h
      .http()
      .post("/v1/auth/logout")
      .set(WEB)
      .set(bearer(res.body.tokens.accessToken));
    expect(out.status).toBe(204);
    expect(refreshCookie(out)!.line).toContain("Max-Age=0");

    const again = await h
      .http()
      .post("/v1/auth/refresh")
      .set(WEB)
      .set("Cookie", `tk_rt=${cookie.value}`);
    expect(again.status).toBe(401);
  });

  it("a web staff session ends at the maximum age even when it is used all the time", async () => {
    const tenant = await createTenant(h);
    const user = await createUser(h, tenant, { username: "mgr", role: "MANAGER" });
    let cookie = refreshCookie(await webLogin(user))!;

    // every 25 minutes: well inside the 30-minute idle time, so only the 1-hour maximum can end it
    for (const minutes of [25, 50]) {
      h.clock.advanceSeconds(25 * 60);
      const res = await h
        .http()
        .post("/v1/auth/refresh")
        .set(WEB)
        .set("Cookie", `tk_rt=${cookie.value}`);
      expect(res.status, `refresh at ${minutes} min`).toBe(200);
      cookie = refreshCookie(res)!;
    }
    h.clock.advanceSeconds(25 * 60); // 75 minutes after sign-in
    const late = await h
      .http()
      .post("/v1/auth/refresh")
      .set(WEB)
      .set("Cookie", `tk_rt=${cookie.value}`);
    expect(late.status).toBe(401);
  });

  it("the access token of a capped session stops working at the maximum age too", async () => {
    const tenant = await createTenant(h);
    const user = await createUser(h, tenant, { username: "mgr", role: "MANAGER" });
    let res = await webLogin(user);
    let cookie = refreshCookie(res)!;
    h.clock.advanceSeconds(25 * 60);
    res = await h.http().post("/v1/auth/refresh").set(WEB).set("Cookie", `tk_rt=${cookie.value}`);
    cookie = refreshCookie(res)!;
    h.clock.advanceSeconds(25 * 60);
    res = await h.http().post("/v1/auth/refresh").set(WEB).set("Cookie", `tk_rt=${cookie.value}`);
    const access = res.body.accessToken as string;
    expect((await h.http().get("/v1/auth/me").set(bearer(access))).status).toBe(200);
    h.clock.advanceSeconds(11 * 60); // 61 minutes after sign-in, the access token itself (15 min) is still valid
    expect((await h.http().get("/v1/auth/me").set(bearer(access))).status).toBe(401);
  });

  it("phone sessions are not capped: an employee keeps refreshing past the staff maximum", async () => {
    const tenant = await createTenant(h);
    const { user } = await createEmployeeWithUser(h, tenant, "emp");
    const login = await h
      .http()
      .post("/v1/auth/login")
      .send({ orgCode: user.orgCode, username: user.username, password: user.password });
    let token = (login.body.tokens as TokenBody).refreshToken;
    for (let i = 0; i < 3; i++) {
      h.clock.advanceSeconds(40 * 60); // 2 hours in total, double the staff maximum
      const res = await h.http().post("/v1/auth/refresh").send({ refreshToken: token });
      expect(res.status).toBe(200);
      token = res.body.refreshToken as string;
    }
  });
});
