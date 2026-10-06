import { describe, expect, it } from "vitest";
import { classifyArrival } from "@timekeeper/domain";
import { HealthController } from "../src/modules/health/health.controller";
import { loadConfig } from "../src/common/config";

describe("HealthController", () => {
  it("reports ok", () => {
    expect(new HealthController().check().status).toBe("ok");
  });
});

describe("loadConfig", () => {
  const secrets = {
    JWT_SECRET: "x".repeat(32),
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  };

  it("applies defaults", () => {
    const config = loadConfig(secrets);
    expect(config.API_PORT).toBe(3001);
    expect(config.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(config.LOGIN_MAX_FAILURES).toBe(5);
  });
  it("rejects an invalid port", () => {
    expect(() => loadConfig({ ...secrets, API_PORT: "-1" })).toThrow();
  });
  it("requires strong secrets", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ ...secrets, JWT_SECRET: "short" })).toThrow();
    expect(() => loadConfig({ ...secrets, DATA_ENCRYPTION_KEY: "AAAA" })).toThrow();
  });
});

describe("workspace linking", () => {
  it("resolves @timekeeper/domain", () => {
    const start = new Date("2026-10-06T08:00:00Z");
    expect(classifyArrival(start, 15, new Date("2026-10-06T08:16:00Z")).status).toBe("LATE");
  });
});
