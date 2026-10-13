import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import { attendanceKit } from "./attendance-kit";
import { type Harness, signIn, startHarness } from "./harness";

describe.skipIf(!hasDb)("list limits", () => {
  let h: Harness;
  let k: ReturnType<typeof attendanceKit>;
  beforeAll(async () => {
    h = await startHarness();
    k = attendanceKit(h);
  });
  afterAll(async () => {
    await h.close();
  });

  it("refuses an offset beyond 100,000 (a deep scan) with 400 and the failing field, and a page size beyond the maximum", async () => {
    const w = await k.world();
    const hr = (await signIn(h, w.hr)).accessToken;
    const get = (query: string) =>
      h.http().get(`/v1/employees?${query}`).set("Authorization", `Bearer ${hr}`);
    expect((await get("offset=100000")).status).toBe(200);
    const deep = await get("offset=100001");
    expect(deep.status).toBe(400);
    expect(deep.body).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(deep.body.issues[0].path).toBe("offset");
    expect((await get("limit=201")).status).toBe(400);
  });
});
