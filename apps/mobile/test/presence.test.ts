import { describe, expect, it } from "vitest";
import type { Region } from "../src/services/plan";
import {
  applyReported,
  distanceM,
  emptyState,
  evaluateFix,
  forRegions,
  type PresenceState,
} from "../src/services/presence";

const place: Region = {
  identifier: "p1",
  latitude: 47.9,
  longitude: 106.9,
  radius: 300,
  notifyOnEnter: true,
  notifyOnExit: true,
};
// about 1 degree of latitude = 111.2 km, so 0.001 degree is about 111 m
const at = (metresNorth: number, accuracyM = 10) => ({
  lat: 47.9 + metresNorth / 111_195,
  lng: 106.9,
  accuracyM,
});

function run(fixes: ReturnType<typeof at>[], start: PresenceState = emptyState()) {
  let state = start;
  const out: string[] = [];
  for (const f of fixes) {
    const r = evaluateFix(state, [place], f);
    state = r.state;
    out.push(r.transitions.map((t) => t.type).join("") || "-");
  }
  return out;
}

describe("distanceM", () => {
  it("is about right", () => {
    expect(Math.round(distanceM(at(0), { lat: 47.9 + 0.001, lng: 106.9 }))).toBeCloseTo(111, -1);
  });
});

describe("evaluateFix", () => {
  it("reports an arrival when the first fix is inside, nothing when it is outside", () => {
    expect(run([at(100)])).toEqual(["ENTER"]);
    expect(run([at(900)])).toEqual(["-"]);
  });

  it("the walk: out and back gives EXIT after two clear fixes, then ENTER on return", () => {
    const walk = [at(50), at(200), at(700), at(900), at(900), at(500), at(100)];
    expect(run(walk)).toEqual(["ENTER", "-", "-", "EXIT", "-", "-", "ENTER"]);
  });

  it("coming back after a departure needs two coarse fixes in a row, or one exact fix", () => {
    const away = [at(50), at(900), at(900)]; // ENTER, then EXIT after two clear fixes
    expect(run([...away, at(100, 90)])).toEqual(["ENTER", "-", "EXIT", "-"]); // one coarse fix inside: not yet
    expect(run([...away, at(100, 90), at(100, 90)])).toEqual(["ENTER", "-", "EXIT", "-", "ENTER"]);
    expect(run([...away, at(100, 10)])).toEqual(["ENTER", "-", "EXIT", "ENTER"]); // one exact fix is enough
    expect(run([...away, at(100, 90), at(900, 90), at(100, 90)])).toEqual([
      "ENTER",
      "-",
      "EXIT",
      "-",
      "-",
      "-",
    ]); // a stray fix breaks the run
  });

  it("one stray fix outside does not end the stay", () => {
    expect(run([at(50), at(900), at(60), at(900), at(60)])).toEqual(["ENTER", "-", "-", "-", "-"]);
  });

  it("the edge of the circle is not outside yet (margin), and poor fixes are ignored", () => {
    expect(run([at(50), at(310), at(320)])).toEqual(["ENTER", "-", "-"]);
    expect(run([at(50), at(2000, 400), at(2000, 400)])).toEqual(["ENTER", "-", "-"]);
  });

  it("forgets places that left the plan", () => {
    const state = { inside: { p1: true, gone: true }, outsideStreak: { gone: 1 } };
    expect(forRegions(state, [place]).inside).toEqual({ p1: true });
  });
});

describe("applyReported", () => {
  it("passes news on and swallows what the fixes already reported", () => {
    const first = applyReported(emptyState(), { type: "ENTER", locationId: "p1" });
    expect(first.emit).toBe(true);
    expect(applyReported(first.state, { type: "ENTER", locationId: "p1" }).emit).toBe(false);
    const exit = applyReported(first.state, { type: "EXIT", locationId: "p1" });
    expect(exit.emit).toBe(true);
    expect(applyReported(exit.state, { type: "EXIT", locationId: "p1" }).emit).toBe(false);
  });
});
