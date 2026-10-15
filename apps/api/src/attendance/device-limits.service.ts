import { Inject, Injectable, Logger } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import { Clock } from "../common/clock";
import { APP_CONFIG, type AppConfig } from "../common/config";
import { RateWindow } from "../common/rate-window";
import type { AuthContext } from "../auth/auth.types";

/**
 * Limits for what a signed-in phone may send (cost control): per account and per organization, per minute. A phone normally sends
 * a handful of calls an hour, so these only ever stop a runaway app version or a stolen login before it fills the database
 * (every event is a new row, every heartbeat rewrites the device row). The refusal is a 429 with `Retry-After`; the phone keeps
 * its queue and tries again later, so nothing is lost.
 */
@Injectable()
export class DeviceLimits {
  private readonly log = new Logger(DeviceLimits.name);
  private readonly events: RateWindow;
  private readonly heartbeats: RateWindow;
  private readonly tenantCalls: RateWindow;
  private readonly warned = new Set<string>();

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly clock: Clock,
  ) {
    this.events = new RateWindow(config.DEVICE_EVENT_CALLS_PER_MINUTE);
    this.heartbeats = new RateWindow(config.DEVICE_HEARTBEATS_PER_MINUTE);
    this.tenantCalls = new RateWindow(config.TENANT_DEVICE_CALLS_PER_MINUTE);
  }

  checkEvents(auth: AuthContext): void {
    this.check("events", this.events, auth);
  }

  checkHeartbeat(auth: AuthContext): void {
    this.check("heartbeat", this.heartbeats, auth);
  }

  private check(kind: string, window: RateWindow, auth: AuthContext): void {
    const now = this.clock.now().getTime();
    const mine = window.hit(auth.userId, now);
    const org = this.tenantCalls.hit(`${kind}:${auth.tenantId}`, now);
    if (mine.ok && org.ok) return;
    const scope = mine.ok ? "tenant" : "account";
    // One log line per account and minute, not one per refused call.
    const marker = `${kind}:${scope}:${mine.ok ? auth.tenantId : auth.userId}:${Math.floor(now / 60_000)}`;
    if (!this.warned.has(marker)) {
      if (this.warned.size > 2000) this.warned.clear();
      this.warned.add(marker);
      this.log.warn(
        JSON.stringify({
          event: "limit.device_rate",
          kind,
          scope,
          tenantId: auth.tenantId,
          userId: auth.userId,
        }),
      );
    }
    throw new ApiError(
      429,
      "DEVICE_RATE_LIMITED",
      "Too many requests from this account. Keep the queued events and try again later.",
      { retryAfterSeconds: Math.max(mine.retryAfterSeconds, org.retryAfterSeconds, 1) },
    );
  }
}
