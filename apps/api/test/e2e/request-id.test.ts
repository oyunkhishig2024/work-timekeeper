import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import { type Harness, startHarness } from "./harness";

describe.skipIf(!hasDb)("request id", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("every response has a fresh X-Request-Id and an error body repeats it", async () => {
    const first = await h.http().get("/v1/employees");
    const second = await h.http().get("/v1/employees").set("X-Request-Id", "chosen-by-the-client");
    expect(first.status).toBe(401);
    expect(first.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first.body.requestId).toBe(first.headers["x-request-id"]);
    // a client cannot choose the id, and each request gets its own
    expect(second.headers["x-request-id"]).not.toBe("chosen-by-the-client");
    expect(second.headers["x-request-id"]).not.toBe(first.headers["x-request-id"]);
  });
});
