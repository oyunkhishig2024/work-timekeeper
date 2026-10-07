import { Injectable } from "@nestjs/common";
import type { Db } from "../database/database.service";
import type { AuthContext } from "../auth/auth.types";

export interface DataScope {
  /** True when the caller sees the whole tenant. */
  unrestricted: boolean;
  locationIds: string[];
  departmentIds: string[];
}

/**
 * Data scope (PRD 4): a Manager sees only the locations/departments assigned to them and nothing when none
 * are assigned (deny by default). HR is limited only if the Org Admin gave them a scope. Org Admin sees all.
 * The scope is enforced on the server in every query, not only in the UI.
 */
@Injectable()
export class ScopeService {
  async forUser(db: Db, auth: AuthContext): Promise<DataScope> {
    if (auth.role === "ORG_ADMIN")
      return { unrestricted: true, locationIds: [], departmentIds: [] };
    const { rows } = await db.query<{ location_id: string | null; department_id: string | null }>(
      "SELECT location_id, department_id FROM user_scope WHERE user_id = $1",
      [auth.userId],
    );
    const locationIds = rows.flatMap((r) => (r.location_id ? [r.location_id] : []));
    const departmentIds = rows.flatMap((r) => (r.department_id ? [r.department_id] : []));
    const scoped = auth.role === "MANAGER" || rows.length > 0;
    return { unrestricted: !scoped, locationIds, departmentIds };
  }

  /**
   * SQL condition limiting employee rows (alias `alias`) to the scope; parameters are appended to `params`.
   * Returns "TRUE" for an unrestricted caller and "FALSE" for a scoped caller with nothing assigned.
   */
  employeeCondition(scope: DataScope, alias: string, params: unknown[]): string {
    if (scope.unrestricted) return "TRUE";
    if (scope.locationIds.length === 0 && scope.departmentIds.length === 0) return "FALSE";
    params.push(scope.locationIds);
    const loc = params.length;
    params.push(scope.departmentIds);
    const dep = params.length;
    return `(${alias}.primary_location_id = ANY($${loc}::uuid[]) OR ${alias}.department_id = ANY($${dep}::uuid[]))`;
  }
}
