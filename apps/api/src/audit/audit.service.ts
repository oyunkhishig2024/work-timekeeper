import { Injectable } from "@nestjs/common";
import type { Db } from "../database/database.service";

export interface AuditEntry {
  tenantId: string;
  action: string;
  actorUserId?: string | null;
  actorRole?: string | null;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Writes append-only audit rows in the SAME transaction as the change they describe (PRD 15.1), so a
 * change and its audit entry commit or roll back together. Never put secrets in before/after.
 */
@Injectable()
export class AuditService {
  async record(db: Db, entry: AuditEntry): Promise<void> {
    await db.query(
      `INSERT INTO audit_log
         (tenant_id, action, actor_user_id, actor_role, entity_type, entity_id, before, after, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.tenantId,
        entry.action,
        entry.actorUserId ?? null,
        entry.actorRole ?? null,
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.ip ?? null,
        entry.userAgent ?? null,
      ],
    );
  }
}
