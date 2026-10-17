import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The refresh token lives in an httpOnly cookie the browser handles; page code must never see or store it.
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const user = { id: "u1", username: "mgr", displayName: null, role: "MANAGER" as const };
let fetchMock: ReturnType<typeof vi.fn>;

async function load(initial: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubGlobal("sessionStorage", memoryStorage(initial));
  return import("../src/lib/session");
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("web session", () => {
  it("signing in keeps no token in the browser's storage and marks the request as the web app", async () => {
    const session = await load();
    fetchMock.mockResolvedValueOnce(
      json(200, { status: "OK", tokens: { accessToken: "access-1", user, requires: [] } }),
    );
    const result = await session.login("org", "mgr", "secret");
    expect(result.kind).toBe("SIGNED_IN");

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ "X-TK-Client": "web" });
    const stored = Object.fromEntries(
      Array.from({ length: sessionStorage.length }, (_, i) => [
        sessionStorage.key(i)!,
        sessionStorage.getItem(sessionStorage.key(i)!)!,
      ]),
    );
    expect(Object.values(stored)).toEqual(["1"]); // only the "signed in" marker, no token of any kind
  });

  it("restoring a session refreshes without sending any token (the cookie carries it)", async () => {
    const session = await load({ "tk.signed-in": "1" });
    fetchMock.mockResolvedValueOnce(json(200, { accessToken: "access-2", user, requires: [] }));
    expect(await session.restoreSession()).toMatchObject({ username: "mgr" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/v1/auth/refresh");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBeUndefined();
  });

  it("does not call refresh at all when this tab was never signed in", async () => {
    const session = await load();
    expect(await session.restoreSession()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a refused refresh ends the session and forgets the marker", async () => {
    const session = await load({ "tk.signed-in": "1" });
    fetchMock.mockResolvedValueOnce(
      json(401, { code: "UNAUTHORIZED", detail: "Invalid refresh token." }),
    );
    expect(await session.restoreSession()).toBeNull();
    expect(sessionStorage.getItem("tk.signed-in")).toBeNull();
  });

  it("removes a refresh token that an older version of the app left in the tab", async () => {
    await load({ "tk.refresh": "old-secret-token" });
    expect(sessionStorage.getItem("tk.refresh")).toBeNull();
  });
});
