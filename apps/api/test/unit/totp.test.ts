import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from "../../src/auth/totp";

// RFC 6238 Appendix B test secret (ASCII "12345678901234567890"), SHA-1; expected values use the last 6 digits.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP (RFC 6238)", () => {
  it("encodes the RFC secret as base32", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(RFC_SECRET).toString()).toBe("12345678901234567890");
  });

  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ])("matches the RFC vector at t=%i", (seconds, expected) => {
    expect(totpCode(RFC_SECRET, seconds * 1000)).toBe(expected);
  });

  it("accepts the current code and ±1 step of drift", () => {
    const now = 1_700_000_000_000;
    for (const offset of [-30_000, 0, 30_000]) {
      expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now + offset), now, null)).not.toBeNull();
    }
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now + 90_000), now, null)).toBeNull();
  });

  it("rejects a replayed code (same or earlier step)", () => {
    const now = 1_700_000_000_000;
    const step = verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now), now, null);
    expect(step).toBe(totpStep(now));
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now), now, step)).toBeNull();
  });

  it("rejects malformed codes", () => {
    for (const code of ["", "12345", "1234567", "abcdef", "12 456"]) {
      expect(verifyTotp(RFC_SECRET, code, 59_000, null)).toBeNull();
    }
  });

  it("generates 160-bit secrets and a Google Authenticator compatible URI", () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    const uri = otpauthUri({ secret, issuer: "Timekeeper Work", account: "khongor" });
    expect(uri.startsWith("otpauth://totp/Timekeeper%20Work%3Akhongor?")).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
