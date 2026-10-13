import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { AnyRole, Public, Roles } from "../../src/auth/decorators";
import { AuthGuard } from "../../src/auth/guards/auth.guard";

/** The guard with the parts around it replaced: a valid token of a signed-in user with the given role. */
function guardFor(role: "EMPLOYEE" | "HR") {
  const tokens = { verifyAccess: async () => ({ sub: "u", tid: "t", sid: "s" }) };
  const sessions = { loadLive: async () => ({ role, employeeId: null, limited: [] }) };
  const db = { withTenant: async (_t: string, fn: (tx: unknown) => unknown) => fn({}) };
  return new AuthGuard(new Reflector(), tokens as never, sessions as never, db as never);
}

function contextOf(controller: new () => object, handler: string): ExecutionContext {
  const request = { headers: { authorization: "Bearer token" } };
  return {
    getHandler: () => (controller.prototype as Record<string, () => void>)[handler],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

class Sample {
  undeclared() {}
  @Roles("HR")
  hrOnly() {}
  @AnyRole()
  anyone() {}
  @Public()
  open() {}
}
Object.defineProperty(Sample.prototype, "undeclared", { value: Sample.prototype.undeclared });

describe("AuthGuard is deny-by-default", () => {
  it("refuses a route that declares neither roles, AnyRole nor Public", async () => {
    await expect(
      guardFor("EMPLOYEE").canActivate(contextOf(Sample, "undeclared")),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: "ROLE_NOT_DECLARED" },
    });
  });

  it("lets a route with @Roles through only for those roles", async () => {
    expect(await guardFor("HR").canActivate(contextOf(Sample, "hrOnly"))).toBe(true);
    await expect(
      guardFor("EMPLOYEE").canActivate(contextOf(Sample, "hrOnly")),
    ).rejects.toMatchObject({
      status: 403,
    });
  });

  it("lets every signed-in role through a route marked @AnyRole, and anybody through @Public", async () => {
    expect(await guardFor("EMPLOYEE").canActivate(contextOf(Sample, "anyone"))).toBe(true);
    expect(await guardFor("EMPLOYEE").canActivate(contextOf(Sample, "open"))).toBe(true);
  });
});
