import { Injectable } from "@nestjs/common";
import { addDays, getExpectation } from "@timekeeper/domain";
import type { AuthContext } from "../auth/auth.types";
import { ApiError } from "../common/api-error";
import { Clock } from "../common/clock";
import { tenantToday } from "../common/tenant-today";
import { DatabaseService } from "../database/database.service";
import { ExpectationLoader, type EmployeeRow } from "../schedule/expectation-loader.service";

/** Today and the next two days: enough for the phone to keep its geofences when it is offline for a while (Architecture 7.3). */
const PLAN_DAYS = 3;

export interface PlanPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
}

/**
 * The geofence plan of the signed-in employee (Architecture 7.3, PRD 15.3): the places to watch on the coming days, taken from the
 * same `getExpectation` the engine uses. The phone registers only these, never every location of the organization, and nothing on a
 * day nobody is expected there.
 */
@Injectable()
export class MobilePlanService {
  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly loader: ExpectationLoader,
  ) {}

  async plan(auth: AuthContext) {
    if (!auth.employeeId) {
      throw new ApiError(403, "EMPLOYEE_ONLY", "Only an employee account has a geofence plan.");
    }
    const employeeId = auth.employeeId;
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const today = await tenantToday(tx, this.clock, auth.tenantId);
      const to = addDays(today, PLAN_DAYS - 1);
      const { rows } = await tx.query<EmployeeRow>(
        `SELECT id, status, start_date::text AS "startDate", end_date::text AS "endDate",
                schedule_mode AS "scheduleMode", primary_location_id AS "primaryLocationId"
           FROM employee WHERE id = $1`,
        [employeeId],
      );
      const employee = rows[0];
      if (!employee) throw new ApiError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
      const data = await this.loader.load(tx, auth.tenantId, addDays(today, -1), to, [employeeId]);

      const places = new Map<string, PlanPlace>();
      const placeRows = (
        await tx.query<{ id: string; name: string; lat: number; lng: number; radiusM: number }>(
          `SELECT id, name, lat, lng, radius_m AS "radiusM" FROM location`,
        )
      ).rows;
      const byId = new Map(placeRows.map((p) => [p.id, p]));

      const days = Array.from({ length: PLAN_DAYS }, (_, i) => addDays(today, i)).map((date) => {
        const x = getExpectation(this.loader.inputFor(data, employee, date));
        if (!x.expected) return { date, expected: false as const, reason: x.reason };
        const here = x.locationIds.flatMap((id) => {
          const p = byId.get(id);
          if (!p) return [];
          const place: PlanPlace = {
            id: p.id,
            name: p.name,
            lat: Number(p.lat),
            lng: Number(p.lng),
            radiusM: p.radiusM,
          };
          places.set(p.id, place);
          return [{ ...place, main: id === x.locationId }];
        });
        return {
          date,
          expected: true as const,
          start: x.start.toISOString(),
          end: x.end.toISOString(),
          locations: here,
        };
      });
      return {
        generatedAt: this.clock.now().toISOString(),
        timeZone: data.timeZone,
        days,
        // every place of the plan once, for the phone to register as geofences
        places: [...places.values()],
      };
    });
  }
}
