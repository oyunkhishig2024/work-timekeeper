import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { Escalation } from "./abuse-detector";

export interface StoredBlock {
  ip: string;
  until: Date;
  /** End times of this address' earlier bans within the last 7 days (the strike count after a restart). */
  strikeEnds: Date[];
}

export interface BlockRow {
  id: string;
  ip: string;
  strike: number;
  reason: string;
  createdAt: Date;
  expiresAt: Date;
  liftedAt: Date | null;
  liftedBy: string | null;
}

/** Persistence of temporary IP bans (table `ip_block`): survives restarts and can be managed by an operator. */
@Injectable()
export class IpBlockStore {
  constructor(private readonly db: DatabaseService) {}

  /** Blocks in force at `now` (not lifted, not expired). */
  async active(now: Date): Promise<StoredBlock[]> {
    return this.db.asPlatform(async (tx) => {
      const blocks = await tx.query<{ ip: string; until: Date }>(
        `SELECT host(ip) AS ip, max(expires_at) AS until FROM ip_block
          WHERE lifted_at IS NULL AND expires_at > $1 GROUP BY ip`,
        [now],
      );
      if (blocks.rows.length === 0) return [];
      const strikes = await tx.query<{ ip: string; starts: Date[] }>(
        `SELECT host(ip) AS ip, array_agg(LEAST(expires_at, COALESCE(lifted_at, expires_at))) AS starts FROM ip_block
          WHERE strike > 0 AND LEAST(expires_at, COALESCE(lifted_at, expires_at)) > $1 AND host(ip) = ANY($2::text[]) GROUP BY ip`,
        [new Date(now.getTime() - 7 * 24 * 3_600_000), blocks.rows.map((b) => b.ip)],
      );
      const byIp = new Map(strikes.rows.map((s) => [s.ip, s.starts]));
      return blocks.rows.map((b) => ({
        ip: b.ip,
        until: b.until,
        strikeEnds: byIp.get(b.ip) ?? [],
      }));
    });
  }

  async recordBan(event: Escalation): Promise<void> {
    await this.db.asPlatform((tx) =>
      tx.query(
        `INSERT INTO ip_block (ip, strike, reason, signals, expires_at) VALUES ($1::inet, $2, $3, $4, $5)`,
        [
          event.ip,
          event.strike,
          event.reason,
          JSON.stringify({ score: event.score, ...event.signals }),
          new Date(event.until),
        ],
      ),
    );
  }

  /** An operator blocks an address by hand (strike 0: it does not count towards escalation). */
  async manualBlock(ip: string, minutes: number, reason: string, now: Date): Promise<Date> {
    const expires = new Date(now.getTime() + minutes * 60_000);
    await this.db.asPlatform((tx) =>
      tx.query(
        `INSERT INTO ip_block (ip, strike, reason, expires_at) VALUES ($1::inet, 0, $2, $3)`,
        [ip, reason, expires],
      ),
    );
    return expires;
  }

  /** Lifts every block in force for the address; returns how many rows changed. */
  async lift(ip: string, by: string, now: Date): Promise<number> {
    return this.db.asPlatform(async (tx) => {
      const res = await tx.query(
        `UPDATE ip_block SET lifted_at = $3, lifted_by = $2 WHERE ip = $1::inet AND lifted_at IS NULL AND expires_at > $3`,
        [ip, by, now],
      );
      return res.rowCount ?? 0;
    });
  }

  async history(ip: string | null, limit: number): Promise<BlockRow[]> {
    return this.db.asPlatform(async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, host(ip) AS ip, strike, reason, created_at AS "createdAt", expires_at AS "expiresAt",
                lifted_at AS "liftedAt", lifted_by AS "liftedBy"
           FROM ip_block WHERE ($1::inet IS NULL OR ip = $1::inet) ORDER BY created_at DESC LIMIT $2`,
        [ip, limit],
      );
      return rows as BlockRow[];
    });
  }
}
