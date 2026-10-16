import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "../security-headers";

describe("web security headers", () => {
  const names = securityHeaders(false).map((h) => h.key);

  it("sends the headers a browser needs to refuse framing, sniffing and leaking", () => {
    for (const key of [
      "Content-Security-Policy",
      "X-Frame-Options",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
    ])
      expect(names).toContain(key);
  });

  it("locks the production policy to this site", () => {
    const csp = contentSecurityPolicy(false);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/https?:/u);
  });

  it("allows eval and websockets only in development", () => {
    expect(contentSecurityPolicy(true)).toContain("'unsafe-eval'");
  });
});
