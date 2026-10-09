import { describe, expect, it } from "vitest";
import type { MyDay } from "../src/lib/api";
import {
  groupHistory,
  hm,
  mondayOf,
  monthRange,
  sundayOf,
  summarize,
} from "../src/features/history/group";
import { errorText } from "../src/i18n/mn";
import { parseRegistrationQr } from "../src/lib/qr";
import { captureEvent } from "../src/services/geofence-capture";
import { allHealthy, evaluateHealth, type HealthInput } from "../src/services/health";

const day = (date: string, over: Partial<MyDay> = {}): MyDay => ({
  date,
  status: "ON_TIME",
  arrivalAt: null,
  lateMinutes: 0,
  reasonName: null,
  departureAt: null,
  departureState: null,
  earlyLeaveMinutes: 0,
  overtimeMinutes: 0,
  ...over,
});

describe("history grouping (month folders, weeks inside)", () => {
  const days = [
    day("2026-10-07"),
    day("2026-10-06", { overtimeMinutes: 95 }),
    day("2026-10-05", { status: "LATE", lateMinutes: 17 }),
    day("2026-10-02", { earlyLeaveMinutes: 200 }),
    day("2026-10-01", { status: "NO_SHOW" }),
    day("2026-09-30"),
  ];
  it("months newest first, weeks inside from Monday to Sunday, days newest first", () => {
    const months = groupHistory(days);
    expect(months.map((m) => m.key)).toEqual(["2026-10", "2026-09"]);
    expect(months[0]!.weeks.map((w) => [w.start, w.end])).toEqual([
      ["2026-10-05", "2026-10-11"],
      ["2026-09-28", "2026-10-04"],
    ]);
    expect(months[0]!.weeks[0]!.days.map((d) => d.date)).toEqual([
      "2026-10-07",
      "2026-10-06",
      "2026-10-05",
    ]);
  });
  it("short time is late plus left-early minutes, overtime is added up, no-show is a day", () => {
    const [oct] = groupHistory(days);
    expect(oct!.summary).toEqual({
      onTime: 3,
      late: 1,
      noShow: 1,
      excused: 0,
      shortMinutes: 217,
      overtimeMinutes: 95,
    });
    expect(oct!.weeks[0]!.summary.overtimeMinutes).toBe(95);
  });
  it("monthRange and the week helpers", () => {
    expect(monthRange("2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(mondayOf("2026-10-11")).toBe("2026-10-05"); // a Sunday
    expect(sundayOf("2026-10-05")).toBe("2026-10-11");
    expect(summarize([])).toMatchObject({ onTime: 0, shortMinutes: 0 });
    expect(hm(95)).toBe("1:35");
    expect(hm(0)).toBe("0:00");
  });
});

describe("parseRegistrationQr", () => {
  it("takes the token of our QR and nothing else", () => {
    expect(parseRegistrationQr("tkw://register?token=abc.def1234567")).toBe("abc.def1234567");
    expect(parseRegistrationQr("  tkw://register?token=abc.def1234567\n")).toBe("abc.def1234567");
    expect(parseRegistrationQr("https://evil.example/?token=abc.def1234567")).toBeNull();
    expect(parseRegistrationQr("tkw://register?token=short")).toBeNull();
    expect(parseRegistrationQr("tkw://register?token=abc.def1234567&x=1")).toBeNull();
    expect(parseRegistrationQr("")).toBeNull();
  });
});

describe("evaluateHealth", () => {
  const good: HealthInput = {
    platform: "ANDROID",
    foregroundLocation: true,
    backgroundLocation: true,
    preciseLocation: true,
    locationServicesOn: true,
    batteryConfirmed: true,
  };
  it("is healthy only when everything is on", () => {
    expect(allHealthy(evaluateHealth(good))).toBe(true);
    for (const key of [
      "backgroundLocation",
      "preciseLocation",
      "locationServicesOn",
      "batteryConfirmed",
    ] as const) {
      expect(allHealthy(evaluateHealth({ ...good, [key]: false }))).toBe(false);
    }
    expect(allHealthy(evaluateHealth({ ...good, foregroundLocation: false }))).toBe(false);
  });
  it("the battery check exists on Android only, and is a manual confirmation", () => {
    expect(evaluateHealth(good).find((c) => c.key === "battery")?.manual).toBe(true);
    expect(
      evaluateHealth({ ...good, platform: "IOS", batteryConfirmed: false }).some(
        (c) => c.key === "battery",
      ),
    ).toBe(false);
  });
});

describe("captureEvent", () => {
  const base = { type: "EXIT" as const, locationId: "loc", now: 5_000, newId: () => "uuid-1" };
  it("records the transition with or without a fix", () => {
    expect(captureEvent(base)).toEqual({
      clientEventId: "uuid-1",
      type: "EXIT",
      locationId: "loc",
      capturedAt: 5_000,
    });
    expect(
      captureEvent({ ...base, fix: { lat: 1, lng: 2, accuracyM: 8, mocked: true } }),
    ).toMatchObject({
      lat: 1,
      lng: 2,
      accuracyM: 8,
      mockLocation: true,
    });
    expect(captureEvent({ ...base, fix: { lat: 1, lng: 2 } })).not.toHaveProperty("mockLocation");
  });
});

describe("errorText", () => {
  it("has Mongolian texts for the codes the app meets and a general one otherwise", () => {
    expect(errorText("CONSENT_REQUIRED")).toMatch(/Зөвшөөрлийн/);
    expect(errorText("QR_EXPIRED")).toMatch(/QR/);
    expect(errorText("SOMETHING_NEW")).toBe(errorText(undefined));
  });
});
