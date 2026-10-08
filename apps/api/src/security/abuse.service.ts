import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../common/config";
import { Clock } from "../common/clock";
import { AbuseDetector, type Escalation } from "./abuse-detector";
import { IpBlockStore } from "./ip-block.store";

const SYNC_MS = 30_000;

/**
 * Owns the detector, writes bans to the database and keeps memory and database in step: a restart restores active
 * bans and strikes, and a ban lifted (or added) by an operator through the CLI takes effect within ~30 seconds.
 */
@Injectable()
export class AbuseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("Security");
  readonly detector: AbuseDetector;
  readonly enabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  /** Wall-clock time each ban reached the database (the sync must not lift a ban that is still being written). */
  private readonly persistedAt = new Map<string, number>();

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly clock: Clock,
    private readonly store: IpBlockStore,
  ) {
    this.enabled = config.ABUSE_PROTECTION === "on";
    this.detector = new AbuseDetector(
      {
        throttleScore: config.ABUSE_THROTTLE_SCORE,
        banScore: config.ABUSE_BAN_SCORE,
        throttlePerMinute: config.ABUSE_THROTTLE_PER_MINUTE,
        anonBurstPer10s: config.ABUSE_ANON_BURST_PER_10S,
        authBurstPer10s: config.ABUSE_AUTH_BURST_PER_10S,
        allowLoopback: config.ABUSE_ALLOW_LOOPBACK,
        allowlist: config.ABUSE_ALLOWLIST.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      },
      (event) => this.escalated(event),
    );
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    await this.sync().catch((error) =>
      this.logger.error(`could not load IP blocks: ${String(error)}`),
    );
    this.timer = setInterval(() => void this.sync().catch(() => undefined), SYNC_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Structured log lines (JSON) that a log shipper / alert rule can match on `event`. */
  private escalated(event: Escalation): void {
    const line = {
      event: event.type === "BAN" ? "security.ip_banned" : "security.ip_throttled",
      ip: event.ip,
      score: event.score,
      strike: event.strike,
      reason: event.reason,
      signals: event.signals,
      ...(event.type === "BAN" ? { until: new Date(event.until).toISOString() } : {}),
    };
    this.logger.warn(JSON.stringify(line));
    if (event.type === "BAN") {
      void this.store
        .recordBan(event)
        .then(() => this.persistedAt.set(event.ip, Date.now()))
        .catch((error) => this.logger.error(`could not store IP ban: ${String(error)}`));
    }
  }

  /** Memory <-> database: apply blocks that exist in the database, drop ones an operator lifted. */
  async sync(): Promise<void> {
    const started = this.clock.now().getTime();
    const syncStartedAt = Date.now();
    const active = await this.store.active(this.clock.now());
    const activeIps = new Set(active.map((b) => b.ip));
    for (const block of active) {
      this.detector.loadBlock(
        block.ip,
        block.until.getTime(),
        block.strikeEnds.map((d) => d.getTime()),
      );
    }
    for (const { ip } of this.detector.blocked(started)) {
      const saved = this.persistedAt.get(ip);
      if (!activeIps.has(ip) && saved !== undefined && saved < syncStartedAt) {
        this.detector.liftBlock(ip);
        this.logger.warn(JSON.stringify({ event: "security.ip_unblocked", ip }));
      }
    }
    this.detector.prune(started);
  }
}
