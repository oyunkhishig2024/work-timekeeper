import type { Db } from "../database/database.service";

export type NotificationKind =
  "DEVICE_ALERT_ATTESTATION" | "DEVICE_ALERT_CONFLICT" | "CORRECTION_VOLUME" | "TEST";

export interface NotificationInput {
  kind: NotificationKind;
  title: string;
  body: string;
  link?: string;
  /** The same event is announced to a user once. */
  dedupeKey: string;
}

/**
 * Announces something to every active Org Admin of the tenant. Call it inside the transaction that records the event, so the
 * notification exists exactly when the event does; the worker pushes it afterwards. Texts must stay generic (no names,
 * places or times): they pass through the browser vendor's push service.
 */
export async function notifyOrgAdmins(
  tx: Db,
  tenantId: string,
  n: NotificationInput,
): Promise<number> {
  const res = await tx.query(
    `INSERT INTO notification (tenant_id, user_id, kind, title, body, link, dedupe_key)
     SELECT $1, u.id, $2, $3, $4, $5, $6 FROM user_account u
      WHERE u.tenant_id = $1 AND u.role = 'ORG_ADMIN' AND u.status = 'ACTIVE'
     ON CONFLICT (tenant_id, user_id, dedupe_key) DO NOTHING`,
    [tenantId, n.kind, n.title, n.body, n.link ?? null, n.dedupeKey],
  );
  return res.rowCount ?? 0;
}
