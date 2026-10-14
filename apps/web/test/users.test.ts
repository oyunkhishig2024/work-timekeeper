import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../src/lib/api";
import { newUserIssue, scopeText, userErrorText } from "../src/lib/users";

describe("newUserIssue", () => {
  const ok = { username: "bat.erdene", displayName: "Бат Эрдэнэ", role: "HR" as const };
  it("accepts a proper account", () => {
    expect(newUserIssue(ok)).toBeNull();
    expect(newUserIssue({ ...ok, username: "  hr_1-a  " })).toBeNull();
  });
  it("names the field that is wrong", () => {
    expect(newUserIssue({ ...ok, username: "ab" })?.field).toBe("username");
    expect(newUserIssue({ ...ok, username: "бат" })?.field).toBe("username");
    expect(newUserIssue({ ...ok, username: "a b c" })?.field).toBe("username");
    expect(newUserIssue({ ...ok, username: "x".repeat(65) })?.field).toBe("username");
    expect(newUserIssue({ ...ok, displayName: "  " })?.field).toBe("displayName");
  });
});

describe("scopeText", () => {
  it("says what each role sees", () => {
    expect(scopeText({ role: "ORG_ADMIN", scopeRules: 0 })).toBe("Бүгд");
    expect(scopeText({ role: "HR", scopeRules: 0 })).toBe("Бүгд");
    expect(scopeText({ role: "HR", scopeRules: 3 })).toMatch(/3/u);
    expect(scopeText({ role: "MANAGER", scopeRules: 0 })).toMatch(/Юу ч харахгүй/u);
    expect(scopeText({ role: "MANAGER", scopeRules: 2 })).toMatch(/2/u);
  });
});

describe("userErrorText", () => {
  it("speaks Mongolian for the known refusals", () => {
    expect(userErrorText(new ApiRequestError(409, "USERNAME_TAKEN", "x"))).toMatch(/ашиглагдаж/u);
    expect(userErrorText(new ApiRequestError(409, "EMPLOYEE_HAS_ACCOUNT", "x"))).toMatch(
      /нэвтрэх эрх/u,
    );
    expect(userErrorText(new ApiRequestError(403, "FORBIDDEN", "x"))).toMatch(/эрх/u);
    expect(userErrorText(new ApiRequestError(400, "OTHER", "server text"))).toBe("server text");
    expect(userErrorText(new Error("network"))).toMatch(/Холбогдож/u);
  });
});
