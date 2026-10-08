import type { Db } from "../database/database.service";
import type { Clock } from "./clock";
import { todayIn } from "./dates";

/** Today's calendar date in the tenant's time zone (PRD 22.2); the default zone is Asia/Ulaanbaatar. */
export async function tenantToday(tx: Db, clock: Clock, tenantId: string): Promise<string> {
  const { rows } = await tx.query<{ time_zone: string }>(
    "SELECT time_zone FROM tenant WHERE id = $1",
    [tenantId],
  );
  return todayIn(rows[0]?.time_zone ?? "Asia/Ulaanbaatar", clock.now());
}
