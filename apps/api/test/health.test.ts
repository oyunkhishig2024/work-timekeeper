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
  it("applies defaults", () => {
    expect(loadConfig({}).API_PORT).toBe(3001);
  });
  it("rejects an invalid port", () => {
    expect(() => loadConfig({ API_PORT: "-1" })).toThrow();
  });
});

describe("workspace linking", () => {
  it("resolves @timekeeper/domain", () => {
    const start = new Date("2026-10-06T08:00:00Z");
    expect(classifyArrival(start, 15, new Date("2026-10-06T08:16:00Z")).status).toBe("LATE");
  });
});
