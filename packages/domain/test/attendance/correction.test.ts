import { describe, expect, it } from "vitest";
import { applyCorrection, correctionProblem, type DerivedAttendance } from "../../src";

const t = (hhmm: string) => new Date(`2026-10-06T${hhmm}:00Z`);
const start = t("08:00");
const noShow: DerivedAttendance = { status: "NO_SHOW", arrivalAt: null, lateMinutes: 0 };
const late: DerivedAttendance = { status: "LATE", arrivalAt: t("08:40"), lateMinutes: 40 };

describe("applyCorrection (PRD 6.9)", () => {
  it("without a correction the system value stays and is marked AUTO", () => {
    expect(applyCorrection(late, null, start)).toEqual({ ...late, source: "AUTO" });
  });
  it("Ирээгүй → Цагтаа with an arrival time (dead phone)", () => {
    expect(applyCorrection(noShow, { status: "ON_TIME", arrivalAt: t("08:05") }, start)).toEqual({
      status: "ON_TIME",
      arrivalAt: t("08:05"),
      lateMinutes: 0,
      source: "CORRECTED",
    });
  });
  it("without an arrival time the system arrival is kept", () => {
    expect(applyCorrection(late, { status: "ON_TIME", arrivalAt: null }, start)).toMatchObject({
      status: "ON_TIME",
      arrivalAt: t("08:40"),
      lateMinutes: 0,
    });
  });
  it("Хоцорсон counts late minutes from the start, never reduced by grace", () => {
    expect(applyCorrection(noShow, { status: "LATE", arrivalAt: t("09:10") }, start)).toMatchObject(
      {
        status: "LATE",
        lateMinutes: 70,
      },
    );
    expect(applyCorrection(noShow, { status: "LATE", arrivalAt: null }, start)).toMatchObject({
      status: "LATE",
      arrivalAt: null,
      lateMinutes: 0,
    });
  });
  it("Ирээгүй removes the arrival", () => {
    expect(applyCorrection(late, { status: "NO_SHOW", arrivalAt: null }, start)).toEqual({
      status: "NO_SHOW",
      arrivalAt: null,
      lateMinutes: 0,
      source: "CORRECTED",
    });
  });
  it("a day nobody is expected cannot be corrected", () => {
    const off: DerivedAttendance = { status: "NOT_EXPECTED", arrivalAt: null, lateMinutes: 0 };
    expect(applyCorrection(off, { status: "ON_TIME", arrivalAt: null }, null).source).toBe("AUTO");
  });
  it("NO_SHOW with an arrival time is invalid", () => {
    expect(correctionProblem({ status: "NO_SHOW", arrivalAt: t("08:00") })).toBe(
      "NO_SHOW_WITH_ARRIVAL",
    );
    expect(correctionProblem({ status: "LATE", arrivalAt: t("08:30") })).toBeNull();
  });
});
