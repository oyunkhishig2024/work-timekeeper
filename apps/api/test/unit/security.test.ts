import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/common/api-error";
import { loadConfig } from "../../src/common/config";
import { PasswordService } from "../../src/auth/password.service";
import { SecretBox } from "../../src/auth/secret-box";
import { Clock } from "../../src/common/clock";
import { TokenService } from "../../src/auth/token.service";
import { canManageRole, requiresTotp } from "../../src/auth/roles";

const config = loadConfig({
  JWT_SECRET: "x".repeat(40),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
});

describe("PasswordService", () => {
  const passwords = new PasswordService();

  it("hashes with Argon2id and verifies", async () => {
    const hash = await passwords.hash("correct horse battery");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await passwords.verify(hash, "correct horse battery")).toBe(true);
    expect(await passwords.verify(hash, "wrong")).toBe(false);
    expect(await passwords.verify("not-a-hash", "x")).toBe(false);
  });

  it.each([
    ["short", "TOO_SHORT"],
    ["password123", "TOO_COMMON"],
    ["aaaaaaaaaaaa", "REPEATED_CHARACTER"],
    ["khongor-2026-ok", "CONTAINS_USERNAME"],
  ])("rejects %s (%s)", (password, reason) => {
    try {
      passwords.assertAcceptable(password, { username: "khongor" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).extra.reasons).toContain(reason);
    }
  });

  it("accepts a reasonable passphrase", () => {
    expect(() =>
      passwords.assertAcceptable("Tsagaan-Davaa 4 ever", { username: "khongor" }),
    ).not.toThrow();
  });

  it("generates distinct 16-character temporary passwords", () => {
    const a = passwords.generateTemporary();
    expect(a).toHaveLength(16);
    expect(a).not.toBe(passwords.generateTemporary());
  });
});

describe("SecretBox", () => {
  const box = new SecretBox(config);

  it("round-trips and uses a fresh IV each time", () => {
    const a = box.encrypt("JBSWY3DPEHPK3PXP");
    expect(a).not.toBe(box.encrypt("JBSWY3DPEHPK3PXP"));
    expect(box.decrypt(a)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("detects tampering", () => {
    const [v, iv, tag, ct] = box.encrypt("secret").split(".");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => box.decrypt([v, iv, tag, flipped.toString("base64url")].join("."))).toThrow();
  });

  it("keyed hash is stable and key-dependent", () => {
    const other = new SecretBox(
      loadConfig({
        ...process.env,
        JWT_SECRET: "x".repeat(40),
        DATA_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
      }),
    );
    expect(box.hmac("CODE")).toBe(box.hmac("CODE"));
    expect(box.hmac("CODE")).not.toBe(other.hmac("CODE"));
  });
});

describe("TokenService", () => {
  const clock = new (class extends Clock {
    current = new Date("2026-10-06T08:00:00Z");
    now() {
      return this.current;
    }
  })();
  const tokens = new TokenService(config, clock);
  const claims = {
    sub: "11111111-1111-4111-8111-111111111111",
    tid: "22222222-2222-4222-8222-222222222222",
    sid: "33333333-3333-4333-8333-333333333333",
    role: "HR" as const,
  };

  it("signs and verifies access tokens, and expires them after 15 minutes", async () => {
    const { token, expiresIn } = await tokens.signAccess(claims);
    expect(expiresIn).toBe(900);
    expect(await tokens.verifyAccess(token)).toMatchObject(claims);
    clock.current = new Date("2026-10-06T08:15:01Z");
    await expect(tokens.verifyAccess(token)).rejects.toThrow();
    clock.current = new Date("2026-10-06T08:00:00Z");
  });

  it("rejects tampered tokens and challenge tokens used as access tokens", async () => {
    const { token } = await tokens.signAccess(claims);
    await expect(tokens.verifyAccess(token.slice(0, -2) + "xx")).rejects.toThrow();
    const challenge = await tokens.signChallenge(claims.sub, claims.tid);
    await expect(tokens.verifyAccess(challenge)).rejects.toThrow();
    expect(await tokens.verifyChallenge(challenge)).toEqual({
      userId: claims.sub,
      tenantId: claims.tid,
    });
  });
});

describe("roles", () => {
  it("requires TOTP for Org Admin and HR only", () => {
    expect(requiresTotp("ORG_ADMIN")).toBe(true);
    expect(requiresTotp("HR")).toBe(true);
    expect(requiresTotp("MANAGER")).toBe(false);
    expect(requiresTotp("EMPLOYEE")).toBe(false);
  });
  it("limits who can manage whom", () => {
    expect(canManageRole("ORG_ADMIN", "HR")).toBe(true);
    expect(canManageRole("HR", "EMPLOYEE")).toBe(true);
    expect(canManageRole("HR", "ORG_ADMIN")).toBe(false);
    expect(canManageRole("MANAGER", "EMPLOYEE")).toBe(false);
  });
});
