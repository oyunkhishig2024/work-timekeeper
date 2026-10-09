import { describe, expect, it } from "vitest";
import type { Plan, PlanPlace } from "../src/lib/api";
import { MAX_REGIONS, MIN_RADIUS_M, regionsChanged, regionsFromPlan } from "../src/services/plan";

const place = (id: string, radiusM = 150): PlanPlace => ({
  id,
  name: id,
  lat: 47.9,
  lng: 106.9,
  radiusM,
});
const plan = (days: Plan["days"], places: PlanPlace[]): Plan => ({
  generatedAt: "t",
  timeZone: "Asia/Ulaanbaatar",
  days,
  places,
});
const day = (date: string, ...ids: Array<[string, boolean]>): Plan["days"][number] => ({
  date,
  expected: true,
  start: "s",
  end: "e",
  locations: ids.map(([id, main]) => ({ ...place(id), main })),
});

describe("regionsFromPlan", () => {
  it("watches the places of the coming days once, the main one first", () => {
    const p = plan(
      [day("d1", ["b", false], ["a", true]), day("d2", ["a", true])],
      [place("a"), place("b")],
    );
    expect(regionsFromPlan(p).map((r) => r.identifier)).toEqual(["a", "b"]);
  });
  it("watches nothing when nobody is expected anywhere", () => {
    expect(regionsFromPlan(plan([{ date: "d", expected: false, reason: "OFF_DAY" }], []))).toEqual(
      [],
    );
  });
  it("raises a small radius to the minimum and asks for both transitions", () => {
    const [r] = regionsFromPlan(plan([day("d", ["a", true])], [place("a", 40)]));
    expect(r).toMatchObject({
      identifier: "a",
      radius: MIN_RADIUS_M,
      notifyOnEnter: true,
      notifyOnExit: true,
    });
  });
  it("never exceeds the 20 regions of iOS and keeps today's places", () => {
    const many = Array.from({ length: 30 }, (_, i) => place(`p${i}`));
    const days = [
      day("d1", ["p0", true]),
      day("d2", ...many.slice(1).map((p): [string, boolean] => [p.id, false])),
    ];
    const regions = regionsFromPlan(plan(days, many));
    expect(regions).toHaveLength(MAX_REGIONS);
    expect(regions[0]!.identifier).toBe("p0");
  });
  it("skips a place the plan lists no coordinates for", () => {
    expect(regionsFromPlan(plan([day("d", ["ghost", true])], []))).toEqual([]);
  });
});

describe("regionsChanged", () => {
  it("only a different set of places, positions or radii counts, not the order", () => {
    const a = regionsFromPlan(
      plan([day("d", ["a", true], ["b", false])], [place("a"), place("b")]),
    );
    const b = [...a].reverse();
    expect(regionsChanged(a, b)).toBe(false);
    expect(regionsChanged(a, a.slice(0, 1))).toBe(true);
    expect(
      regionsChanged(
        a,
        a.map((r) => ({ ...r, radius: r.radius + 1 })),
      ),
    ).toBe(true);
  });
});
