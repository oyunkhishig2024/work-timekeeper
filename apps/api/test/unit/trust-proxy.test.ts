import { describe, expect, it } from "vitest";
import { parseTrustProxy } from "../../src/security/trust-proxy";

describe("TRUST_PROXY", () => {
  it("accepts a hop count or a list of trusted proxies", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy(" 2 ")).toBe(2);
    expect(parseTrustProxy("loopback")).toEqual(["loopback"]);
    expect(parseTrustProxy("loopback, 10.0.0.0/8 ,")).toEqual(["loopback", "10.0.0.0/8"]);
    expect(parseTrustProxy("")).toBe(1);
  });
});
