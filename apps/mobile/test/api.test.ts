import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/lib/api";
import { ApiError, NetworkError, SessionEndedError } from "../src/lib/errors";
import { fakeFetch, MemoryTokens } from "./helpers";

const make = (
  handler: Parameters<typeof fakeFetch>[0],
  tokens = new MemoryTokens({ accessToken: "a1", refreshToken: "r1" }),
) => {
  const f = fakeFetch(handler);
  let ended = 0;
  const api = new ApiClient({
    baseUrl: "http://api",
    tokens,
    fetchImpl: f.impl,
    onSessionEnded: () => (ended += 1),
    appVersion: "0.1.0",
  });
  return { api, tokens, calls: f.calls, ended: () => ended };
};

describe("ApiClient", () => {
  it("sends the bearer token and the app version", async () => {
    const { api, calls } = make(() => [200, { from: "x", to: "y", summary: {}, items: [] }]);
    await api.myAttendance("2026-10-01", "2026-10-31");
    expect(calls[0]).toMatchObject({
      url: "/v1/me/attendance?from=2026-10-01&to=2026-10-31",
      auth: "Bearer a1",
    });
  });

  it("renews the token once on 401 and repeats the call; the refresh token rotates", async () => {
    const { api, tokens, calls } = make((c, n) =>
      c.url === "/v1/auth/refresh"
        ? [200, { accessToken: "a2", refreshToken: "r2", user: {}, requires: [] }]
        : n === 1
          ? [401, { code: "UNAUTHORIZED" }]
          : [200, { serverTime: "t" }],
    );
    expect(await api.heartbeat()).toEqual({ serverTime: "t" });
    expect(calls.map((c) => [c.url, c.auth])).toEqual([
      ["/v1/heartbeat", "Bearer a1"],
      ["/v1/auth/refresh", null],
      ["/v1/heartbeat", "Bearer a2"],
    ]);
    expect(calls[1]!.body).toEqual({ refreshToken: "r1" });
    expect(tokens.value).toEqual({ accessToken: "a2", refreshToken: "r2" });
  });

  it("calls that fail together share one refresh (a replayed refresh token would end the session)", async () => {
    let refreshes = 0;
    const { api } = make((c) => {
      if (c.url === "/v1/auth/refresh") {
        refreshes += 1;
        return [200, { accessToken: "a2", refreshToken: "r2", user: {}, requires: [] }];
      }
      return c.auth === "Bearer a1" ? [401, { code: "UNAUTHORIZED" }] : [200, { serverTime: "t" }];
    });
    await Promise.all([api.heartbeat(), api.heartbeat(), api.heartbeat()]);
    expect(refreshes).toBe(1);
  });

  it("a refused refresh ends the session: tokens dropped, the shell told", async () => {
    const { api, tokens, ended } = make((c) =>
      c.url === "/v1/auth/refresh"
        ? [401, { code: "UNAUTHORIZED" }]
        : [401, { code: "UNAUTHORIZED" }],
    );
    await expect(api.heartbeat()).rejects.toBeInstanceOf(SessionEndedError);
    expect(tokens.value).toBeNull();
    expect(ended()).toBe(1);
  });

  it("a server error during the refresh is not the end of the session", async () => {
    const { api, tokens, ended } = make((c) =>
      c.url === "/v1/auth/refresh" ? [503, {}] : [401, {}],
    );
    await expect(api.heartbeat()).rejects.toBeInstanceOf(ApiError);
    expect(tokens.value).not.toBeNull();
    expect(ended()).toBe(0);
  });

  it("no network is a NetworkError, and the tokens stay", async () => {
    const { api, tokens } = make(() => "network");
    await expect(api.heartbeat()).rejects.toBeInstanceOf(NetworkError);
    expect(tokens.value).not.toBeNull();
  });

  it("turns problem+json into an ApiError with the stable code and the extra fields", async () => {
    const { api } = make(() => [
      409,
      { code: "CONSENT_REQUIRED", detail: "no consent", status: 409 },
    ]);
    const err = await api
      .registerDevice({ qrToken: "x".repeat(12), platform: "ANDROID" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "CONSENT_REQUIRED", message: "no consent" });
  });

  it("without tokens a signed-in call is a SessionEndedError, nothing is sent", async () => {
    const { api, calls } = make(() => [200, {}], new MemoryTokens(null));
    await expect(api.plan()).rejects.toBeInstanceOf(SessionEndedError);
    expect(calls).toHaveLength(0);
  });

  describe("sign-in", () => {
    const tokens = {
      accessToken: "A",
      refreshToken: "R",
      user: { id: "u" },
      requires: [] as string[],
    };
    it("stores the tokens after a plain login", async () => {
      const {
        api,
        tokens: store,
        calls,
      } = make(() => [200, { status: "OK", tokens }], new MemoryTokens(null));
      const res = await api.login("310", "ganbat", "pw");
      expect(res.status).toBe("OK");
      expect(store.value).toEqual({ accessToken: "A", refreshToken: "R" });
      expect(calls[0]).toMatchObject({
        url: "/v1/auth/login",
        auth: null,
        body: { orgCode: "310", username: "ganbat", password: "pw" },
      });
    });
    it("a two-step login returns the challenge; the 6-digit code or a recovery code finishes it", async () => {
      const {
        api,
        tokens: store,
        calls,
      } = make(
        (c) =>
          c.url === "/v1/auth/login"
            ? [200, { status: "MFA_REQUIRED", challengeToken: "ch" }]
            : [200, tokens],
        new MemoryTokens(null),
      );
      expect(await api.login("310", "hr", "pw")).toEqual({
        status: "MFA_REQUIRED",
        challengeToken: "ch",
      });
      expect(store.value).toBeNull();
      await api.verifyTotp("ch", "123456");
      await api.verifyTotp("ch", "ABCD-EFGH-IJKL");
      expect(calls[1]!.body).toEqual({ challengeToken: "ch", code: "123456" });
      expect(calls[2]!.body).toEqual({ challengeToken: "ch", recoveryCode: "ABCD-EFGH-IJKL" });
      expect(store.value).toEqual({ accessToken: "A", refreshToken: "R" });
    });
    it("signing out drops the tokens even without a network", async () => {
      const { api, tokens: store } = make(() => "network");
      await api.logout();
      expect(store.value).toBeNull();
    });
  });
});
