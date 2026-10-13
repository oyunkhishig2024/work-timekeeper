import { describe, expect, it } from "vitest";
import { scheduleError, timesInOrder } from "../src/lib/schedule";

describe("schedule helpers", () => {
  it("compares the two times of a day", () => {
    expect(timesInOrder("08:30", "17:30")).toBe(true);
    expect(timesInOrder("17:30", "08:30")).toBe(false);
    expect(timesInOrder("08:30", "08:30")).toBe(false);
    expect(timesInOrder(null, "08:30")).toBe(false);
  });
  it("explains the error codes in Mongolian and passes unknown ones through", () => {
    expect(scheduleError("EFFECTIVE_DATE_IN_PAST", "x")).toContain("өнгөрсөн");
    expect(scheduleError("SOMETHING_ELSE", "raw message")).toBe("raw message");
  });
});
