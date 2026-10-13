import { BadRequestException, type ArgumentsHost } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ProblemFilter } from "../../src/common/problem.filter";

/** A response that remembers what was sent, standing in for Express. */
function fakeResponse(requestId = "req-1") {
  const sent: { status?: number; body?: Record<string, unknown>; headers: Record<string, string> } =
    {
      headers: { "X-Request-Id": requestId },
    };
  const res = {
    getHeader: (name: string) => sent.headers[name],
    setHeader: (name: string, value: string) => {
      sent.headers[name] = value;
    },
    status(code: number) {
      sent.status = code;
      return res;
    },
    type: () => res,
    json(body: Record<string, unknown>) {
      sent.body = body;
      return res;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  return { sent, host };
}

const pgError = (code: string, constraint = "some_constraint") =>
  Object.assign(new Error("db"), { code, severity: "ERROR", constraint });

describe("ProblemFilter", () => {
  it("answers a validation failure with 400, the failing fields and the request id", () => {
    const { sent, host } = fakeResponse();
    const parsed = z.object({ name: z.string() }).safeParse({});
    new ProblemFilter().catch(parsed.error, host);
    expect(sent.status).toBe(400);
    expect(sent.body).toMatchObject({ code: "VALIDATION_ERROR", requestId: "req-1" });
    expect(sent.body?.issues).toEqual([{ path: "name", message: expect.any(String) }]);
  });

  it("keeps the status and code of an HttpException", () => {
    const { sent, host } = fakeResponse();
    new ProblemFilter().catch(new BadRequestException({ code: "NOPE", detail: "no" }), host);
    expect(sent.status).toBe(400);
    expect(sent.body).toMatchObject({ code: "NOPE", detail: "no", requestId: "req-1" });
  });

  it.each([
    ["23505", 409, "DUPLICATE"],
    ["23503", 409, "REFERENCE_CONFLICT"],
    ["23P01", 409, "OVERLAP"],
    ["23514", 400, "INVALID_DATA"],
    ["23502", 400, "INVALID_DATA"],
    ["22P02", 400, "INVALID_DATA"],
    ["40001", 503, "TRY_AGAIN"],
  ])(
    "turns the database rule %s that no service handled into %i %s, not a 500",
    (pg, status, code) => {
      const { sent, host } = fakeResponse();
      new ProblemFilter().catch(pgError(pg), host);
      expect(sent.status).toBe(status);
      expect(sent.body).toMatchObject({ code, requestId: "req-1" });
      // the name of the constraint is for the log, not for the caller
      expect(JSON.stringify(sent.body)).not.toContain("some_constraint");
      if (status === 503) expect(sent.headers["Retry-After"]).toBe("1");
    },
  );

  it("answers anything else with a generic 500 that leaks nothing and still carries the request id", () => {
    const { sent, host } = fakeResponse("req-9");
    new ProblemFilter().catch(new Error("select password_hash from secret exploded"), host);
    expect(sent.status).toBe(500);
    expect(sent.body).toMatchObject({ code: "INTERNAL_ERROR", requestId: "req-9" });
    expect(JSON.stringify(sent.body)).not.toContain("password_hash");
  });
});
