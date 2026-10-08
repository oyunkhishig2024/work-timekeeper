import { Injectable } from "@nestjs/common";
import {
  addDays,
  candidateWorkDates,
  daysBetween,
  deriveOffDayStatus,
  deriveStatus,
  getExpectation,
  instantToLocalDate,
  attestationFlag,
  isImpossibleSpeed,
  isTraceConflict,
  matchedFixes,
  nextUnavailableStreak,
  reachesEscalation,
  CONFLICT_MAX_GAP_SECONDS,
  type BatchVerdict,
  type Fix,
  applyCorrection,
  deriveDeparture,
  type AttendanceStatus,
  type Correction,
  type DerivedAttendance,
  type Expectation,
  type GeofenceEvent,
} from "@timekeeper/domain";
import { ScopeService } from "../access/scope.service";
import type { AuthContext } from "../auth/auth.types";
import { ApiError } from "../common/api-error";
import { Clock } from "../common/clock";
import { tenantToday } from "../common/tenant-today";
import { DatabaseService, type Db } from "../database/database.service";
import { AttestationVerifier } from "../devices/attestation";
import { raiseDeviceAlert } from "./device-alerts";
import { ExpectationLoader, type EmployeeRow } from "../schedule/expectation-loader.service";

/** PRD 6.8 / 6.7 thresholds. */
export const CLOCK_SKEW_MS = 2 * 60_000;
export const LATE_SYNC_MS = 24 * 3_600_000;
export const MIN_ACCURACY_M = 50;
/** Flags that put an event in the anomaly review queue (PRD 6.7). LATE_SYNC is a sync matter, not suspicion. */
export const REVIEW_FLAGS = [
  "MOCK_LOCATION",
  "LOW_ACCURACY",
  "CLOCK_SKEW",
  "IMPOSSIBLE_SPEED",
  "ATTESTATION_FAILED",
  "DEVICE_CONFLICT",
] as const;
/** PRD 15.3: raw coordinates are erased after 30 days. */
export const COORDINATE_RETENTION_DAYS = 30;
const MAX_RECOMPUTE_DAYS = 62;
const CHUNK = 200;

export interface IncomingEvent {
  clientEventId: string;
  type: "ENTER" | "EXIT";
  locationId: string;
  /** Milliseconds between the event and this upload, measured on the device's monotonic clock (PRD 6.8). */
  ageMs: number;
  /** The phone's wall clock at the event; only used to flag CLOCK_SKEW. */
  deviceTime?: string;
  accuracyM?: number;
  /** The phone reported that the fix came from a mock-location provider (PRD 6.7). */
  mockLocation?: boolean;
  /** Position of the fix (PRD 6.7); both or neither. Used for the impossible-speed check, erased after 30 days. */
  lat?: number;
  lng?: number;
}

export type EventOutcome =
  | {
      clientEventId: string;
      outcome: "ACCEPTED";
      occurredAt: string;
      counted: boolean;
      flags: string[];
    }
  | { clientEventId: string; outcome: "DUPLICATE" }
  | { clientEventId: string; outcome: "REJECTED"; code: "UNKNOWN_LOCATION" };

interface EventRow {
  employeeId: string;
  locationId: string;
  type: "ENTER" | "EXIT";
  at: Date;
  counted: boolean;
  flagged: boolean;
}

interface CorrectionRow extends Correction {
  id: string;
  employeeId: string;
  workDate: string;
}

interface ExistingRow {
  employeeId: string;
  workDate: string;
  status: AttendanceStatus;
}

const rate = (n: number, total: number): number =>
  total === 0 ? 0 : Math.round((n / total) * 1000) / 10;

/**
 * Attendance engine (PRD 6): stores device events with server-authoritative time and keeps `attendance_result`
 * in step with them. It only loads data and persists; every decision is made by `getExpectation` and
 * `deriveStatus` in packages/domain.
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly scopes: ScopeService,
    private readonly loader: ExpectationLoader,
    private readonly attestation: AttestationVerifier,
  ) {}

  // ------------------------------------------------------------------ ingest (PRD 6.7, 6.8)

  async ingest(
    auth: AuthContext,
    events: IncomingEvent[],
    batch: { attestationToken?: string; attestationKeyId?: string } = {},
  ) {
    if (!auth.employeeId) {
      throw new ApiError(
        403,
        "EMPLOYEE_ONLY",
        "Only an employee account can report geofence events.",
      );
    }
    const employeeId = auth.employeeId;
    const receivedAt = this.clock.now();
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const dev = await tx.query<{
        deviceId: string | null;
        status: string | null;
        employeeId: string | null;
        platform: "ANDROID" | "IOS" | null;
        keyId: string | null;
        streak: number | null;
      }>(
        `SELECT s.device_id AS "deviceId", d.status, d.employee_id AS "employeeId", d.platform,
                d.attestation_key_id AS "keyId", d.attestation_unavailable_streak AS streak
           FROM auth_session s LEFT JOIN device d ON d.tenant_id = s.tenant_id AND d.id = s.device_id
          WHERE s.id = $1`,
        [auth.sessionId],
      );
      const device = dev.rows[0];
      if (!device?.deviceId || device.status !== "ACTIVE" || device.employeeId !== employeeId) {
        throw new ApiError(
          403,
          "DEVICE_REQUIRED",
          "Events are accepted only from the employee's registered, active device.",
        );
      }
      const known = new Set(
        (
          await tx.query<{ id: string }>("SELECT id FROM location WHERE id = ANY($1::uuid[])", [
            [...new Set(events.map((e) => e.locationId))],
          ])
        ).rows.map((r) => r.id),
      );

      // PRD 6.7: one verdict for the whole batch. A verdict service that cannot be reached never blocks attendance.
      const verdict = await this.batchVerdict(device.platform!, device.keyId, batch);
      const batchFlags: string[] = [];
      const verdictFlag = attestationFlag(verdict);
      if (verdictFlag) batchFlags.push(verdictFlag);
      // PRD 6.7 buddy punching: this session's device is not the install that was registered.
      if (batch.attestationKeyId && device.keyId && batch.attestationKeyId !== device.keyId) {
        batchFlags.push("DEVICE_CONFLICT");
        const other = await tx.query<{ employeeId: string }>(
          'SELECT employee_id AS "employeeId" FROM device WHERE attestation_key_id = $1 AND employee_id <> $2',
          [batch.attestationKeyId, employeeId],
        );
        await raiseDeviceAlert(tx, {
          tenantId: auth.tenantId,
          kind: "DEVICE_CONFLICT",
          deviceId: device.deviceId,
          employeeId,
          relatedEmployeeId: other.rows[0]?.employeeId ?? null,
          detail: other.rows[0]
            ? "The install key belongs to another employee's device."
            : "The install key differs from the registered device.",
        });
      }
      await this.recordVerdict(
        tx,
        auth.tenantId,
        employeeId,
        device.deviceId,
        device.streak ?? 0,
        verdict,
        receivedAt,
      );

      const results: EventOutcome[] = [];
      const occurredTimes: Date[] = [];
      // Oldest first, so that every fix is compared with the one before it in time.
      const ordered = [...events].sort((a, b) => b.ageMs - a.ageMs);
      for (const e of ordered) {
        if (!known.has(e.locationId)) {
          results.push({
            clientEventId: e.clientEventId,
            outcome: "REJECTED",
            code: "UNKNOWN_LOCATION",
          });
          continue;
        }
        // Server time is the authority: the arrival is "now minus how long ago the phone says it happened".
        const ageMs = Math.max(0, Math.round(e.ageMs));
        const occurredAt = new Date(receivedAt.getTime() - ageMs);
        const claimed = e.deviceTime ? new Date(e.deviceTime) : null;
        const flags: string[] = [...batchFlags];
        if (claimed && Math.abs(claimed.getTime() - occurredAt.getTime()) > CLOCK_SKEW_MS) {
          flags.push("CLOCK_SKEW");
        }
        if (ageMs > LATE_SYNC_MS) flags.push("LATE_SYNC");
        // Accept and flag (PRD 6.7): a mock fix still counts, but HR reviews it.
        if (e.mockLocation) flags.push("MOCK_LOCATION");
        // PRD 6.7: a fix that cannot be reached from the neighbouring trusted fixes in the time between them.
        if (
          e.lat !== undefined &&
          e.lng !== undefined &&
          (await this.impossibleSpeed(tx, employeeId, {
            at: occurredAt,
            lat: e.lat,
            lng: e.lng,
            accuracyM: e.accuracyM ?? null,
          }))
        ) {
          flags.push("IMPOSSIBLE_SPEED");
        }
        // PRD 6.7: identical coordinates and movement as another employee's device.
        if (e.lat !== undefined && e.lng !== undefined) {
          const partner = await this.traceConflict(tx, employeeId, {
            at: occurredAt,
            lat: e.lat,
            lng: e.lng,
          });
          if (partner) {
            if (!flags.includes("DEVICE_CONFLICT")) flags.push("DEVICE_CONFLICT");
            await raiseDeviceAlert(tx, {
              tenantId: auth.tenantId,
              kind: "DEVICE_CONFLICT",
              deviceId: device.deviceId,
              employeeId,
              relatedEmployeeId: partner,
              detail: "Identical coordinates and movement as another employee's device.",
            });
          }
        }
        // An imprecise fix never confirms an arrival (PRD 6.7); leaving is always honoured.
        if (e.type === "ENTER" && e.accuracyM !== undefined && e.accuracyM > MIN_ACCURACY_M) {
          flags.push("LOW_ACCURACY");
        }
        const counted = !flags.includes("LATE_SYNC") && !flags.includes("LOW_ACCURACY");
        const inserted = await tx.query(
          `INSERT INTO device_event (tenant_id, employee_id, device_id, location_id, client_event_id, type,
                                     occurred_at, received_at, claimed_at, accuracy_m, flags, counted, review_status,
                                     lat, lng)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           ON CONFLICT (tenant_id, device_id, client_event_id) DO NOTHING
           RETURNING id`,
          [
            auth.tenantId,
            employeeId,
            device.deviceId,
            e.locationId,
            e.clientEventId,
            e.type,
            occurredAt,
            receivedAt,
            claimed && !Number.isNaN(claimed.getTime()) ? claimed : null,
            e.accuracyM ?? null,
            flags,
            counted,
            flags.some((f) => (REVIEW_FLAGS as readonly string[]).includes(f)) ? "PENDING" : null,
            e.lat ?? null,
            e.lng ?? null,
          ],
        );
        if (inserted.rowCount === 0) {
          results.push({ clientEventId: e.clientEventId, outcome: "DUPLICATE" });
          continue;
        }
        results.push({
          clientEventId: e.clientEventId,
          outcome: "ACCEPTED",
          occurredAt: occurredAt.toISOString(),
          counted,
          flags,
        });
        if (counted) occurredTimes.push(occurredAt);
      }
      await tx.query(
        "UPDATE device SET last_seen_at = $2 WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < $2)",
        [device.deviceId, receivedAt],
      );
      if (occurredTimes.length > 0) {
        const tz = await this.timeZone(tx, auth.tenantId);
        const dates = occurredTimes.flatMap((t) => candidateWorkDates(t, tz)).sort();
        await this.recompute(
          tx,
          auth.tenantId,
          [employeeId],
          dates[0]!,
          dates[dates.length - 1]!,
          receivedAt,
        );
      }
      return { received: results.length, results };
    });
  }

  private async batchVerdict(
    platform: "ANDROID" | "IOS",
    registeredKeyId: string | null,
    batch: { attestationToken?: string; attestationKeyId?: string },
  ): Promise<BatchVerdict> {
    try {
      return await this.attestation.verifyBatch({
        platform,
        keyId: batch.attestationKeyId ?? registeredKeyId ?? undefined,
        token: batch.attestationToken,
      });
    } catch {
      return "UNAVAILABLE";
    }
  }

  private async recordVerdict(
    tx: Db,
    tenantId: string,
    employeeId: string,
    deviceId: string,
    previousStreak: number,
    verdict: BatchVerdict,
    at: Date,
  ) {
    if (verdict === "UNVERIFIED") return;
    await tx.query(
      `UPDATE device SET attestation_unavailable_streak = $2, last_batch_verdict = $3, last_batch_attested_at = $4
        WHERE id = $1`,
      [deviceId, nextUnavailableStreak(previousStreak, verdict), verdict, at],
    );
    if (reachesEscalation(previousStreak, verdict)) {
      await raiseDeviceAlert(tx, {
        tenantId,
        kind: "ATTESTATION_UNAVAILABLE_STREAK",
        deviceId,
        employeeId,
        detail: "The attestation service did not answer for five batches in a row.",
      });
    }
  }

  /**
   * The employee whose device reports the same places at the same times as this fix and the employee's recent fixes (PRD
   * 6.7), or null. Looks at the last 24 hours; the rule itself (`isTraceConflict`) is in packages/domain.
   */
  private async traceConflict(tx: Db, employeeId: string, fix: Fix): Promise<string | null> {
    const since = new Date(fix.at.getTime() - 24 * 3_600_000);
    const until = new Date(fix.at.getTime() + CONFLICT_MAX_GAP_SECONDS * 1000);
    const mine: Fix[] = (
      await tx.query<{ at: Date; lat: number; lng: number }>(
        `SELECT occurred_at AS at, lat, lng FROM device_event
          WHERE employee_id = $1 AND lat IS NOT NULL AND occurred_at BETWEEN $2 AND $3`,
        [employeeId, since, fix.at],
      )
    ).rows;
    mine.push(fix);
    const others = (
      await tx.query<{ employeeId: string; at: Date; lat: number; lng: number }>(
        `SELECT employee_id AS "employeeId", occurred_at AS at, lat, lng FROM device_event
          WHERE employee_id <> $1 AND lat IS NOT NULL AND occurred_at BETWEEN $2 AND $3
            AND review_status IS DISTINCT FROM 'REJECTED'
            AND (round(lat::numeric, 5), round(lng::numeric, 5)) IN (
              SELECT round(t.lat::numeric, 5), round(t.lng::numeric, 5) FROM unnest($4::float8[], $5::float8[]) AS t(lat, lng))`,
        [employeeId, since, until, mine.map((m) => m.lat), mine.map((m) => m.lng)],
      )
    ).rows;
    const byEmployee = new Map<string, Fix[]>();
    for (const o of others)
      byEmployee.set(o.employeeId, [...(byEmployee.get(o.employeeId) ?? []), o]);
    for (const [other, theirs] of byEmployee) {
      if (isTraceConflict(matchedFixes(mine, theirs))) return other;
    }
    return null;
  }

  /**
   * Compares a new fix with the trusted fixes just before and after it (not rejected, not mock, not already flagged for
   * speed). Only the new event is flagged; the older ones stay as they were.
   */
  private async impossibleSpeed(tx: Db, employeeId: string, fix: Fix): Promise<boolean> {
    const { rows } = await tx.query<{
      at: Date;
      lat: number;
      lng: number;
      accuracy: number | null;
    }>(
      `(SELECT occurred_at AS at, lat, lng, accuracy_m::float AS accuracy FROM device_event
         WHERE employee_id = $1 AND lat IS NOT NULL AND occurred_at <= $2
           AND review_status IS DISTINCT FROM 'REJECTED' AND NOT (flags && ARRAY['MOCK_LOCATION', 'IMPOSSIBLE_SPEED'])
         ORDER BY occurred_at DESC LIMIT 1)
       UNION ALL
       (SELECT occurred_at AS at, lat, lng, accuracy_m::float AS accuracy FROM device_event
         WHERE employee_id = $1 AND lat IS NOT NULL AND occurred_at > $2
           AND review_status IS DISTINCT FROM 'REJECTED' AND NOT (flags && ARRAY['MOCK_LOCATION', 'IMPOSSIBLE_SPEED'])
         ORDER BY occurred_at ASC LIMIT 1)`,
      [employeeId, fix.at],
    );
    return rows.some((r) =>
      isImpossibleSpeed({ at: r.at, lat: r.lat, lng: r.lng, accuracyM: r.accuracy }, fix),
    );
  }

  /** Worker: clears raw coordinates older than the retention period; the event and its geofence level stay (PRD 15.3). */
  async eraseOldCoordinates(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - COORDINATE_RETENTION_DAYS * 86_400_000);
    const tenants = await this.db.asPlatform(async (tx) =>
      (await tx.query<{ id: string }>("SELECT id FROM tenant")).rows.map((r) => r.id),
    );
    let erased = 0;
    for (const tenantId of tenants) {
      erased += await this.db.withTenant(tenantId, async (tx) => {
        const res = await tx.query(
          `UPDATE device_event SET lat = NULL, lng = NULL, coordinates_erased_at = $1
            WHERE lat IS NOT NULL AND received_at < $2`,
          [this.clock.now(), cutoff],
        );
        return res.rowCount ?? 0;
      });
    }
    return erased;
  }

  /** The phone reports it is alive (PRD 5: heartbeat shows silent devices to HR). */
  async heartbeat(auth: AuthContext) {
    if (!auth.employeeId)
      throw new ApiError(403, "EMPLOYEE_ONLY", "Only an employee device sends heartbeats.");
    const now = this.clock.now();
    await this.db.withTenant(auth.tenantId, async (tx) => {
      await tx.query(
        `UPDATE device SET last_seen_at = $2
          WHERE status = 'ACTIVE' AND employee_id = $3
            AND id = (SELECT device_id FROM auth_session WHERE id = $1)`,
        [auth.sessionId, now, auth.employeeId],
      );
    });
    return { serverTime: now.toISOString() };
  }

  // ------------------------------------------------------------------ evaluation

  /**
   * Re-evaluates every employee for the dates [from, to]. Safe to repeat: results are derived data.
   * Returns how many rows changed status.
   */
  async recomputeRange(auth: AuthContext, from: string, to: string, employeeId?: string) {
    const days = daysBetween(from, to) + 1;
    if (days < 1) throw new ApiError(400, "INVALID_DATES", "`to` is before `from`.");
    if (days > MAX_RECOMPUTE_DAYS) {
      throw new ApiError(
        400,
        "RANGE_TOO_LONG",
        `Recompute at most ${MAX_RECOMPUTE_DAYS} days at a time.`,
      );
    }
    const now = this.clock.now();
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const ids = employeeId ? [employeeId] : await this.employeeIds(tx, to);
      const changed = await this.recompute(tx, auth.tenantId, ids, from, to, now);
      return { from, to, employees: ids.length, changed };
    });
  }

  /** Worker tick (every minute): moves PENDING to NO_SHOW at the cut-off for yesterday and today, in every tenant. */
  async tick(): Promise<number> {
    const tenants = await this.db.asPlatform(async (tx) =>
      (await tx.query<{ id: string }>("SELECT id FROM tenant")).rows.map((r) => r.id),
    );
    let changed = 0;
    for (const tenantId of tenants) {
      changed += await this.tickTenant(tenantId);
    }
    return changed;
  }

  async tickTenant(tenantId: string): Promise<number> {
    const now = this.clock.now();
    return this.db.withTenant(tenantId, async (tx) => {
      const today = await tenantToday(tx, this.clock, tenantId);
      const ids = await this.employeeIds(tx, today);
      return this.recompute(tx, tenantId, ids, addDays(today, -1), today, now);
    });
  }

  private async timeZone(tx: Db, tenantId: string): Promise<string> {
    const { rows } = await tx.query<{ time_zone: string }>(
      "SELECT time_zone FROM tenant WHERE id = $1",
      [tenantId],
    );
    return rows[0]?.time_zone ?? "Asia/Ulaanbaatar";
  }

  /** Employees who could be on duty on or before `date`: not archived and already employed. */
  private async employeeIds(tx: Db, date: string): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM employee
        WHERE status <> 'ARCHIVED' AND (start_date IS NULL OR start_date <= $1::date)
        ORDER BY id`,
      [date],
    );
    return rows.map((r) => r.id);
  }

  async recompute(
    tx: Db,
    tenantId: string,
    employeeIds: string[],
    from: string,
    to: string,
    now: Date,
  ): Promise<number> {
    let changed = 0;
    for (let i = 0; i < employeeIds.length; i += CHUNK) {
      changed += await this.recomputeChunk(
        tx,
        tenantId,
        employeeIds.slice(i, i + CHUNK),
        from,
        to,
        now,
      );
    }
    return changed;
  }

  private async recomputeChunk(
    tx: Db,
    tenantId: string,
    ids: string[],
    from: string,
    to: string,
    now: Date,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const employees = (
      await tx.query<EmployeeRow>(
        `SELECT id, status, start_date::text AS "startDate", end_date::text AS "endDate",
                schedule_mode AS "scheduleMode", primary_location_id AS "primaryLocationId"
           FROM employee WHERE id = ANY($1::uuid[])`,
        [ids],
      )
    ).rows;
    const data = await this.loader.load(tx, tenantId, from, to, ids);
    // A duty can start the evening before `from` and last until the next day, so the window is generous.
    const eventRows = (
      await tx.query<EventRow>(
        `SELECT employee_id AS "employeeId", location_id AS "locationId", type, occurred_at AS at,
                counted, review_status IN ('PENDING', 'RECHECK_REQUESTED') AS flagged
           FROM device_event
          WHERE employee_id = ANY($1::uuid[]) AND occurred_at >= $2 AND occurred_at < $3
          ORDER BY occurred_at`,
        [ids, new Date(`${addDays(from, -2)}T00:00:00Z`), new Date(`${addDays(to, 3)}T00:00:00Z`)],
      )
    ).rows;
    const existing = new Map<string, ExistingRow>();
    for (const r of (
      await tx.query<ExistingRow>(
        `SELECT employee_id AS "employeeId", work_date::text AS "workDate", status
           FROM attendance_result
          WHERE employee_id = ANY($1::uuid[]) AND work_date BETWEEN $2 AND $3`,
        [ids, from, to],
      )
    ).rows) {
      existing.set(`${r.employeeId}|${r.workDate}`, r);
    }

    const corrections = new Map<string, CorrectionRow>();
    for (const c of (
      await tx.query<CorrectionRow>(
        `SELECT id, employee_id AS "employeeId", work_date::text AS "workDate", status, arrival_at AS "arrivalAt"
           FROM attendance_correction
          WHERE employee_id = ANY($1::uuid[]) AND work_date BETWEEN $2 AND $3 AND revoked_at IS NULL`,
        [ids, from, to],
      )
    ).rows) {
      corrections.set(`${c.employeeId}|${c.workDate}`, c);
    }

    const dates = Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => addDays(from, i));
    let changed = 0;
    for (const e of employees) {
      const mine = eventRows.filter((r) => r.employeeId === e.id);
      for (const date of dates) {
        const expectation = getExpectation(this.loader.inputFor(data, e, date));
        const reasonName = data.reasonOn(e.id, date);
        const reasonNote = data.reasonNoteOn(e.id, date);
        const counted = mine.filter((r) => r.counted);
        const system = this.derive(
          expectation,
          counted,
          e.primaryLocationId,
          reasonName !== null,
          now,
          data,
          date,
        );
        // The departure of the confirmed arrival (HR's correction does not move it): the last EXIT of the duty place.
        const departure = expectation.expected
          ? deriveDeparture({
              expectation,
              events: counted
                .filter((r) => expectation.locationIds.includes(r.locationId))
                .map((r) => ({ type: r.type, at: r.at })),
              arrivalAt: system.arrivalAt,
              now,
            })
          : { state: null, departureAt: null };
        // PRD 6.9: a correction is layered over the system value, which is kept next to it.
        const correction = corrections.get(`${e.id}|${date}`) ?? null;
        const derived = applyCorrection(
          system,
          correction,
          expectation.expected ? expectation.start : null,
        );
        const flagged = expectation.expected
          ? mine.filter(
              (r) =>
                r.flagged &&
                expectation.locationIds.includes(r.locationId) &&
                r.at < expectation.end,
            ).length
          : 0;
        const key = `${e.id}|${date}`;
        const before = existing.get(key)?.status ?? null;
        if (derived.status === "NOT_EXPECTED") {
          if (before !== null) {
            await tx.query(
              "DELETE FROM attendance_result WHERE employee_id = $1 AND work_date = $2",
              [e.id, date],
            );
            await this.log(tx, tenantId, e.id, date, before, "NOT_EXPECTED", now);
            changed++;
          }
          continue;
        }
        await tx.query(
          `INSERT INTO attendance_result (tenant_id, employee_id, work_date, status, location_id, expected_start,
                                          expected_cutoff, arrival_at, late_minutes, reason_name, missing, computed_at,
                                          source, system_status, system_arrival_at, flagged_events, correction_id, reason_note,
                                          departure_at, departure_state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
           ON CONFLICT (tenant_id, employee_id, work_date) DO UPDATE SET
             status = EXCLUDED.status, location_id = EXCLUDED.location_id, expected_start = EXCLUDED.expected_start,
             expected_cutoff = EXCLUDED.expected_cutoff, arrival_at = EXCLUDED.arrival_at,
             late_minutes = EXCLUDED.late_minutes, reason_name = EXCLUDED.reason_name,
             missing = EXCLUDED.missing, computed_at = EXCLUDED.computed_at, source = EXCLUDED.source,
             system_status = EXCLUDED.system_status, system_arrival_at = EXCLUDED.system_arrival_at,
             flagged_events = EXCLUDED.flagged_events, correction_id = EXCLUDED.correction_id,
             reason_note = EXCLUDED.reason_note, departure_at = EXCLUDED.departure_at,
             departure_state = EXCLUDED.departure_state`,
          [
            tenantId,
            e.id,
            date,
            derived.status,
            expectation.expected ? expectation.locationId : null,
            expectation.expected ? expectation.start : null,
            expectation.expected ? expectation.cutoff : null,
            derived.arrivalAt,
            derived.lateMinutes,
            derived.status === "EXCUSED" ? reasonName : null,
            !expectation.expected && expectation.reason === "NOT_CONFIGURED"
              ? expectation.missing
              : null,
            now,
            derived.source,
            system.status,
            system.arrivalAt,
            flagged,
            correction?.id ?? null,
            derived.status === "EXCUSED" ? reasonNote : null,
            departure.departureAt,
            departure.state,
          ],
        );
        if (before !== derived.status) {
          await this.log(tx, tenantId, e.id, date, before, derived.status, now);
          changed++;
        }
      }
    }
    return changed;
  }

  private derive(
    expectation: Expectation,
    events: Array<{ locationId: string; type: "ENTER" | "EXIT"; at: Date }>,
    primaryLocationId: string,
    hasReason: boolean,
    now: Date,
    data: Awaited<ReturnType<ExpectationLoader["load"]>>,
    date: string,
  ): DerivedAttendance {
    if (expectation.expected) {
      const own: GeofenceEvent[] = events
        .filter((r) => expectation.locationIds.includes(r.locationId) && r.at < expectation.end)
        .map((r) => ({ type: r.type, at: r.at }));
      return deriveStatus({ expectation, events: own, hasReason, now });
    }
    // Nobody is expected: only a holiday / off day can turn a confirmed stay into WORKED_OFF_DAY.
    const minStay = data.rules.find((r) => r.locationId === null)?.minStayMinutes ?? 3;
    const day = events
      .filter(
        (r) =>
          r.locationId === primaryLocationId && instantToLocalDate(r.at, data.timeZone) === date,
      )
      .map((r) => ({ type: r.type, at: r.at }));
    return deriveOffDayStatus(expectation, day, minStay, now);
  }

  private async log(
    tx: Db,
    tenantId: string,
    employeeId: string,
    date: string,
    oldStatus: string | null,
    newStatus: string,
    at: Date,
  ) {
    await tx.query(
      `INSERT INTO attendance_result_log (tenant_id, employee_id, work_date, old_status, new_status, changed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, employeeId, date, oldStatus, newStatus, at],
    );
  }

  // ------------------------------------------------------------------ reading (PRD 7, 8)

  /**
   * Dashboard numbers for one date (PRD 7–8). "Total" is everyone expected that day (Ажиллах ёстой): on time + late
   * + excused + no show + still pending. Rates are shares of that total with one decimal.
   */
  async summary(auth: AuthContext, date: string) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [date];
      const cond = this.scopes.employeeCondition(scope, "e", params);
      const { rows } = await tx.query<{
        locationId: string | null;
        locationName: string | null;
        departmentId: string | null;
        departmentName: string | null;
        status: AttendanceStatus;
        n: number;
      }>(
        `SELECT l.id AS "locationId", l.name AS "locationName", d.id AS "departmentId", d.name AS "departmentName",
                r.status, count(*)::int AS n
           FROM attendance_result r
           JOIN employee e ON e.id = r.employee_id
           LEFT JOIN department d ON d.id = e.department_id
           LEFT JOIN location l ON l.id = COALESCE(r.location_id, e.primary_location_id)
          WHERE r.work_date = $1 AND ${cond} AND r.status <> 'WORKED_OFF_DAY' AND r.status <> 'NOT_CONFIGURED'
          GROUP BY 1, 2, 3, 4, 5`,
        params,
      );
      const extra = await tx.query<{ status: string; n: number }>(
        `SELECT r.status, count(*)::int AS n FROM attendance_result r JOIN employee e ON e.id = r.employee_id
          WHERE r.work_date = $1 AND ${cond} AND r.status IN ('WORKED_OFF_DAY', 'NOT_CONFIGURED') GROUP BY 1`,
        params,
      );
      const flagged = await tx.query<{ n: number; corrected: number }>(
        `SELECT count(*) FILTER (WHERE r.flagged_events > 0)::int AS n,
                count(*) FILTER (WHERE r.source = 'CORRECTED')::int AS corrected
           FROM attendance_result r JOIN employee e ON e.id = r.employee_id
          WHERE r.work_date = $1 AND ${cond} AND r.status NOT IN ('WORKED_OFF_DAY', 'NOT_CONFIGURED')`,
        params,
      );
      type Bucket = { id: string | null; name: string | null; counts: Record<string, number> };
      const group = (
        idKey: "locationId" | "departmentId",
        nameKey: "locationName" | "departmentName",
      ) => {
        const map = new Map<string, Bucket>();
        for (const r of rows) {
          const key = r[idKey] ?? "none";
          const b = map.get(key) ?? { id: r[idKey], name: r[nameKey], counts: {} };
          b.counts[r.status] = (b.counts[r.status] ?? 0) + r.n;
          map.set(key, b);
        }
        return [...map.values()].map((b) => ({
          id: b.id,
          name: b.name,
          ...this.figures(b.counts),
        }));
      };
      const all: Record<string, number> = {};
      for (const r of rows) all[r.status] = (all[r.status] ?? 0) + r.n;
      return {
        date,
        ...this.figures(all),
        workedOffDay: extra.rows.find((r) => r.status === "WORKED_OFF_DAY")?.n ?? 0,
        notConfigured: extra.rows.find((r) => r.status === "NOT_CONFIGURED")?.n ?? 0,
        // PRD 6.7: how many counted days still have an event waiting for review; the counts above may change.
        flagged: flagged.rows[0]!.n,
        corrected: flagged.rows[0]!.corrected,
        byLocation: group("locationId", "locationName"),
        byDepartment: group("departmentId", "departmentName"),
      };
    });
  }

  private figures(c: Record<string, number>) {
    const onTime = c.ON_TIME ?? 0;
    const late = c.LATE ?? 0;
    const excused = c.EXCUSED ?? 0;
    const noShow = c.NO_SHOW ?? 0;
    const pending = c.PENDING ?? 0;
    const total = onTime + late + excused + noShow + pending;
    return {
      total,
      onTime,
      late,
      excused,
      noShow,
      pending,
      onTimeRate: rate(onTime, total),
      lateRate: rate(late, total),
      excusedRate: rate(excused, total),
      noShowRate: rate(noShow, total),
    };
  }

  /** The employee's own history (mobile "Миний ирц"). */
  async mine(auth: AuthContext, from: string, to: string) {
    if (!auth.employeeId)
      throw new ApiError(403, "EMPLOYEE_ONLY", "Only an employee account has its own attendance.");
    if (daysBetween(from, to) > 92) throw new ApiError(400, "RANGE_TOO_LONG", "At most 93 days.");
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT work_date::text AS date, status, arrival_at AS "arrivalAt", late_minutes AS "lateMinutes",
                reason_name AS "reasonName", expected_start AS "expectedStart"
           FROM attendance_result WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3
          ORDER BY work_date DESC`,
        [auth.employeeId, from, to],
      );
      return { from, to, items: rows };
    });
  }
}
