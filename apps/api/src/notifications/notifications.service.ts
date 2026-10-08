import { Inject, Injectable, Logger } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import { Clock } from "../common/clock";
import { APP_CONFIG, type AppConfig } from "../common/config";
import { DatabaseService } from "../database/database.service";
import type { AuthContext } from "../auth/auth.types";
import {
  isAllowedPushEndpoint,
  PushDeliveryError,
  PushSender,
  pushRetryDelayMinutes,
} from "./push-sender";

const BATCH = 50;

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly push: PushSender,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------ subscriptions

  pushConfig() {
    return { enabled: this.push.enabled, publicKey: this.push.publicKey() };
  }

  async subscribe(
    auth: AuthContext,
    input: { endpoint: string; p256dh: string; auth: string },
    userAgent: string | null,
  ) {
    if (!isAllowedPushEndpoint(input.endpoint, this.config.PUSH_ENDPOINT_HOSTS)) {
      throw new ApiError(
        400,
        "PUSH_ENDPOINT_NOT_ALLOWED",
        "This is not a known browser push service.",
      );
    }
    await this.db.withTenant(auth.tenantId, async (tx) => {
      // A browser that signs in as someone else takes the subscription over (and is switched on again).
      await tx.query(
        `INSERT INTO push_subscription (tenant_id, user_id, endpoint, p256dh, auth, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, endpoint) DO UPDATE SET
           user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent, disabled_at = NULL`,
        [
          auth.tenantId,
          auth.userId,
          input.endpoint,
          input.p256dh,
          input.auth,
          userAgent?.slice(0, 300) ?? null,
        ],
      );
    });
    return { subscribed: true };
  }

  async unsubscribe(auth: AuthContext, endpoint: string) {
    await this.db.withTenant(auth.tenantId, async (tx) => {
      await tx.query(
        "UPDATE push_subscription SET disabled_at = $3 WHERE user_id = $1 AND endpoint = $2 AND disabled_at IS NULL",
        [auth.userId, endpoint, this.clock.now()],
      );
    });
    return { subscribed: false };
  }

  /** Sends a test message to the caller only, so an admin can check that push reaches the browser. */
  async test(auth: AuthContext) {
    await this.db.withTenant(auth.tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO notification (tenant_id, user_id, kind, title, body, link, dedupe_key)
         VALUES ($1, $2, 'TEST', 'Туршилтын мэдэгдэл', 'Push мэдэгдэл энэ хөтөч дээр ажиллаж байна.', NULL, $3)`,
        [auth.tenantId, auth.userId, `test:${this.clock.now().getTime()}:${Math.random()}`],
      );
    });
    return { queued: true };
  }

  // ------------------------------------------------------------------ inbox

  async inbox(auth: AuthContext, f: { unreadOnly: boolean; limit: number; offset: number }) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const where = ["user_id = $1", ...(f.unreadOnly ? ["read_at IS NULL"] : [])].join(" AND ");
      const counts = await tx.query<{ total: number; unread: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE read_at IS NULL)::int AS unread
           FROM notification WHERE ${where}`,
        [auth.userId],
      );
      const unread = await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND read_at IS NULL",
        [auth.userId],
      );
      const { rows } = await tx.query(
        `SELECT id, kind, title, body, link, created_at AS "createdAt", read_at AS "readAt", push_state AS "pushState"
           FROM notification WHERE ${where} ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`,
        [auth.userId, f.limit, f.offset],
      );
      return {
        total: counts.rows[0]!.total,
        unread: unread.rows[0]!.n,
        limit: f.limit,
        offset: f.offset,
        items: rows,
      };
    });
  }

  async markRead(auth: AuthContext, id: string | null) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const res = await tx.query(
        `UPDATE notification SET read_at = $3 WHERE user_id = $1 AND read_at IS NULL AND ($2::uuid IS NULL OR id = $2)`,
        [auth.userId, id, this.clock.now()],
      );
      if (id && res.rowCount === 0) {
        const exists = await tx.query("SELECT 1 FROM notification WHERE id = $1 AND user_id = $2", [
          id,
          auth.userId,
        ]);
        if (exists.rows.length === 0)
          throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "No such notification.");
      }
      return { marked: res.rowCount ?? 0 };
    });
  }

  // ------------------------------------------------------------------ delivery (worker)

  /** Pushes everything that is due, in every tenant. Returns how many notifications were sent. */
  async dispatchDue(): Promise<number> {
    const tenants = await this.db.asPlatform(async (tx) =>
      (await tx.query<{ id: string }>("SELECT id FROM tenant")).rows.map((r) => r.id),
    );
    let sent = 0;
    for (const tenantId of tenants) sent += await this.dispatchTenant(tenantId);
    return sent;
  }

  async dispatchTenant(tenantId: string): Promise<number> {
    return this.db.withTenant(tenantId, async (tx) => {
      const now = this.clock.now();
      const due = await tx.query<{
        id: string;
        userId: string;
        kind: string;
        title: string;
        body: string;
        link: string | null;
        attempts: number;
      }>(
        `SELECT id, user_id AS "userId", kind, title, body, link, push_attempts AS attempts FROM notification
          WHERE push_state = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
          ORDER BY created_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`,
        [now],
      );
      let sent = 0;
      for (const n of due.rows) {
        const subs = this.push.enabled
          ? (
              await tx.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
                "SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE user_id = $1 AND disabled_at IS NULL",
                [n.userId],
              )
            ).rows
          : [];
        if (subs.length === 0) {
          // Nobody to push to (not configured, or no browser subscribed): the inbox is the delivery.
          await tx.query("UPDATE notification SET push_state = 'SKIPPED' WHERE id = $1", [n.id]);
          continue;
        }
        let delivered = 0;
        let retry = false;
        let lastError: string | null = null;
        for (const sub of subs) {
          try {
            await this.push.send(sub, {
              title: n.title,
              body: n.body,
              url: n.link,
              tag: n.kind,
              notificationId: n.id,
            });
            delivered++;
            await tx.query("UPDATE push_subscription SET last_success_at = $2 WHERE id = $1", [
              sub.id,
              now,
            ]);
          } catch (error) {
            const e =
              error instanceof PushDeliveryError
                ? error
                : new PushDeliveryError(null, String(error));
            lastError = `${e.statusCode ?? "ERR"}: ${e.message}`.slice(0, 300);
            if (e.gone) {
              await tx.query("UPDATE push_subscription SET disabled_at = $2 WHERE id = $1", [
                sub.id,
                now,
              ]);
            } else {
              retry = true;
            }
          }
        }
        if (delivered > 0) {
          await tx.query(
            "UPDATE notification SET push_state = 'SENT', push_sent_at = $2, push_error = NULL WHERE id = $1",
            [n.id, now],
          );
          sent++;
        } else if (!retry) {
          // Every subscription was gone.
          await tx.query(
            "UPDATE notification SET push_state = 'SKIPPED', push_error = $2 WHERE id = $1",
            [n.id, lastError],
          );
        } else {
          const attempt = n.attempts + 1;
          const delay = pushRetryDelayMinutes(attempt);
          if (delay === null) {
            await tx.query(
              "UPDATE notification SET push_state = 'FAILED', push_attempts = $2, push_error = $3 WHERE id = $1",
              [n.id, attempt, lastError],
            );
            this.log.warn(`push gave up on notification ${n.id}: ${lastError}`);
          } else {
            await tx.query(
              "UPDATE notification SET push_attempts = $2, push_error = $3, next_attempt_at = $4 WHERE id = $1",
              [n.id, attempt, lastError, new Date(now.getTime() + delay * 60_000)],
            );
          }
        }
      }
      return sent;
    });
  }
}
