import { ApiError } from "../common/api-error";
import type { Db } from "../database/database.service";

type VersionTable = "working_week_version" | "attendance_rule_version";

interface VersionRow {
  id: string;
  validFrom: string;
  validTo: string | null;
}

/**
 * Effective-dated versions of one scope (the tenant default, or one location) form a timeline of half-open ranges
 * [validFrom, validTo) that never overlap (PRD 22.1). This prepares the scope for a new version starting on
 * `effective`: versions that have not started yet are dropped (they are being replaced), and the one in force ends
 * the day the new one starts. The caller then inserts the new version.
 */
export async function makeRoomFrom(
  tx: Db,
  table: VersionTable,
  locationId: string | null,
  effective: string,
  today: string,
): Promise<void> {
  await tx.query(
    `DELETE FROM ${table} WHERE location_id IS NOT DISTINCT FROM $1 AND valid_from > $2`,
    [locationId, today],
  );
  // The version in force pointed at the dropped one (its end date was the dropped start): reopen it.
  await tx.query(
    `UPDATE ${table} SET valid_to = NULL
      WHERE location_id IS NOT DISTINCT FROM $1 AND valid_to IS NOT NULL AND valid_to > $2`,
    [locationId, today],
  );
  const latest = (
    await tx.query<VersionRow>(
      `SELECT id, valid_from::text AS "validFrom", valid_to::text AS "validTo"
         FROM ${table} WHERE location_id IS NOT DISTINCT FROM $1
        ORDER BY valid_from DESC LIMIT 1 FOR UPDATE`,
      [locationId],
    )
  ).rows[0];
  if (!latest) return;
  if (latest.validTo === null) {
    if (effective <= latest.validFrom) {
      throw new ApiError(
        409,
        "EFFECTIVE_DATE_NOT_AFTER_CURRENT",
        "The effective date must be after the current version started.",
        { currentFrom: latest.validFrom },
      );
    }
    await tx.query(`UPDATE ${table} SET valid_to = $2 WHERE id = $1`, [latest.id, effective]);
  } else if (effective < latest.validTo) {
    throw new ApiError(
      409,
      "EFFECTIVE_DATE_NOT_AFTER_CURRENT",
      "The effective date overlaps the previous version.",
      { previousUntil: latest.validTo },
    );
  }
}
