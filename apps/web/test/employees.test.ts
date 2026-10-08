import { describe, expect, it } from "vitest";
import {
  createBody,
  emptyForm,
  employeeFormProblem,
  employeesHref,
  formFrom,
  listQuery,
  parseListState,
  patchBody,
  type EmployeeDetail,
} from "../src/lib/employees";

const id = "11111111-2222-3333-4444-555555555555";
const detail: EmployeeDetail = {
  id: "e1",
  employeeNo: "2026100800000001",
  fullName: "Бат Болд",
  lastName: "Бат",
  firstName: "Болд",
  status: "ACTIVE",
  departmentId: "d1",
  departmentName: "Агуулах",
  primaryLocationId: "l1",
  locationName: "Төв салбар",
  startDate: "2026-01-05",
  endDate: null,
  scheduleMode: "STANDARD",
  manualAttendance: false,
  rank: "Ахмад",
  position: "Нярав",
  consentStatus: "SIGNED",
  hasActiveDevice: true,
  account: null,
  device: null,
};

describe("employee form", () => {
  const valid = {
    ...emptyForm,
    lastName: "Бат",
    firstName: "Болд",
    departmentId: "d1",
    primaryLocationId: "l1",
  };
  it("needs both names, a department and a branch; the code is not a field", () => {
    expect(employeeFormProblem(valid)).toBeNull();
    expect(employeeFormProblem({ ...valid, lastName: " " })).toMatch(/Овго/u);
    expect(employeeFormProblem({ ...valid, firstName: "" })).toMatch(/Нэр/u);
    expect(employeeFormProblem({ ...valid, departmentId: "" })).toMatch(/Нэгж/u);
    expect(employeeFormProblem({ ...valid, primaryLocationId: "" })).toMatch(/салбар/u);
    expect(employeeFormProblem({ ...valid, startDate: "2026-02-30" })).toMatch(/огноо/u);
    expect(employeeFormProblem({ ...valid, rank: "x".repeat(121) })).toMatch(/120/u);
    expect(Object.keys(emptyForm)).not.toContain("employeeNo");
  });

  it("creates with trimmed text and leaves empty optional fields out", () => {
    expect(createBody({ ...valid, lastName: " Бат ", rank: "  ", position: " Нярав " })).toEqual({
      lastName: "Бат",
      firstName: "Болд",
      departmentId: "d1",
      primaryLocationId: "l1",
      scheduleMode: "STANDARD",
      manualAttendance: false,
      position: "Нярав",
    });
  });

  it("an edit sends only what changed; an emptied rank or position is null (removes it)", () => {
    const same = formFrom(detail);
    expect(patchBody(detail, same)).toEqual({});
    expect(patchBody(detail, { ...same, firstName: "Болдбаатар", departmentId: "d2" })).toEqual({
      firstName: "Болдбаатар",
      departmentId: "d2",
    });
    expect(patchBody(detail, { ...same, rank: "", position: "Ахлах нярав" })).toEqual({
      rank: null,
      position: "Ахлах нярав",
    });
    expect(patchBody(detail, { ...same, startDate: "" })).toEqual({ startDate: null });
    expect(patchBody(detail, { ...same, rank: " Ахмад " })).toEqual({}); // trimmed, unchanged
    expect(patchBody({ ...detail, rank: null }, { ...formFrom(detail), rank: "" })).toEqual({});
  });
});

describe("list URL and query", () => {
  it("round-trips the filters; active and page 1 are the defaults and stay out of the URL", () => {
    const state = {
      q: "бат",
      status: "DISABLED" as const,
      departmentId: id,
      locationId: null,
      page: 3,
    };
    const href = employeesHref(state);
    expect(href).toBe(`/employees?q=%D0%B1%D0%B0%D1%82&status=DISABLED&department=${id}&page=3`);
    expect(parseListState(new URLSearchParams(href.split("?")[1]!))).toEqual(state);
    expect(employeesHref({})).toBe("/employees");
    expect(employeesHref({ status: "ACTIVE", page: 1 })).toBe("/employees");
  });
  it("ignores unknown values and absurd pages", () => {
    expect(parseListState(new URLSearchParams("status=X&department=1%27&page=-4"))).toEqual({
      q: "",
      status: "ACTIVE",
      departmentId: null,
      locationId: null,
      page: 1,
    });
    expect(parseListState(new URLSearchParams("page=999999")).page).toBe(1);
  });
  it("pages through the API with limit and offset", () => {
    expect(
      listQuery({ q: " Бат ", status: "ACTIVE", departmentId: null, locationId: id, page: 3 }),
    ).toBe(
      `status=ACTIVE&limit=50&offset=100&sort=employeeNo&q=%D0%91%D0%B0%D1%82&locationId=${id}`,
    );
  });
});
