import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../common/config";
import { Clock } from "../common/clock";
import { AbuseDetector, createMemoryStore, type Escalation } from "./abuse-detector";
import { createSharedStore } from "./abuse-redis";
import type { AbuseStateStore } from "./abuse-state";
import { IpBlockStore } from "./ip-block.store";

const SYNC_MS = 30_000;

/**
 * Owns the detector, writes bans to the database and keeps the judgement state and the database in step: a restart
 * restores active bans and strikes, and a ban lifted (or added) by an operator through the CLI takes effect within
 * ~30 seconds. The judgement state is in process memory, or in Redis when REDIS_URL is set (several API instances
 * then share it; see README.md in this folder).
 */
@Injectable()
export class AbuseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("Security");
  readonly detector: AbuseDetector;
  readonly enabled: boolean;
  readonly store: AbuseStateStore;
  private timer: NodeJS.Timeout | null = null;
  private readonly connectRedis: ((waitMs: number) => Promise<void>) | null = null;
  /** Blocks the database listed as active at the previous sync (an operator lift is noticed when one disappears). */
  private knownActive = new Map<string, number>();
  /** Wall-clock time each ban reached the database (the sync must not lift a ban that is still being written). */
  private readonly persistedAt = new Map<string, number>();

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly clock: Clock,
    private readonly blocks: IpBlockStore,
  ) {
    this.enabled = config.ABUSE_PROTECTION === "on";
    const options = {
      throttleScore: config.ABUSE_THROTTLE_SCORE,
      banScore: config.ABUSE_BAN_SCORE,
      throttlePerMinute: config.ABUSE_THROTTLE_PER_MINUTE,
      anonBurstPer10s: config.ABUSE_ANON_BURST_PER_10S,
      authBurstPer10s: config.ABUSE_AUTH_BURST_PER_10S,
      allowLoopback: config.ABUSE_ALLOW_LOOPBACK,
      allowlist: config.ABUSE_ALLOWLIST.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    const memory = createMemoryStore(options);
    if (this.enabled && config.REDIS_URL) {
      const shared = createSharedStore(memory, {
        url: config.REDIS_URL,
        prefix: config.ABUSE_REDIS_PREFIX,
        timeoutMs: config.ABUSE_REDIS_TIMEOUT_MS,
        failures: config.ABUSE_REDIS_BREAKER_FAILURES,
        cooldownMs: config.ABUSE_REDIS_BREAKER_COOLDOWN_SECONDS * 1000,
        log: (line) => this.logger.warn(JSON.stringify(line)),
      });
      this.store = shared.store;
      this.connectRedis = shared.connect;
    } else {
      this.store = memory;
    }
    this.detector = new AbuseDetector(options, (event) => this.escalated(event), this.store);
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    if (this.connectRedis) await this.connectRedis(1500);
    await this.sync().catch((error) =>
      this.logger.error(`could not load IP blocks: ${String(error)}`),
    );
    this.timer = setInterval(() => void this.sync().catch(() => undefined), SYNC_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.store.close?.();
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
      void this.blocks
        .recordBan(event)
        .then(() => this.persistedAt.set(event.ip, Date.now()))
        .catch((error) => this.logger.error(`could not store IP ban: ${String(error)}`));
    }
  }

  /**
   * Judgement state <-> database: apply blocks that exist in the database (to the shared state too, so every
   * instance enforces them), drop ones an operator lifted (also from Redis).
   */
  async sync(): Promise<void> {
    const started = this.clock.now().getTime();
    const syncStartedAt = Date.now();
    const active = await this.blocks.active(this.clock.now());
    const activeIps = new Set(active.map((b) => b.ip));
    for (const block of active) {
      await this.detector.loadBlock(
        block.ip,
        block.until.getTime(),
        block.strikeEnds.map((d) => d.getTime()),
      );
    }
    // Lifted by an operator: a block that was in force at the previous sync (or that this instance wrote itself a
    // moment ago) and is no longer listed. Every instance does this; lifting twice is harmless.
    const lifted = new Set<string>();
    for (const [ip, until] of this.knownActive)
      if (until > started && !activeIps.has(ip)) lifted.add(ip);
    for (const [ip, saved] of this.persistedAt)
      if (!activeIps.has(ip) && saved < syncStartedAt) lifted.add(ip);
    for (const ip of lifted) {
      const state = await this.detector.inspect(ip, started);
      if (state && state.blockedUntil > started) {
        await this.detector.liftBlock(ip);
        this.logger.warn(JSON.stringify({ event: "security.ip_unblocked", ip }));
      }
      this.persistedAt.delete(ip);
    }
    for (const ip of activeIps) this.persistedAt.delete(ip); // now known to the database: tracked by `knownActive`
    this.knownActive = new Map(active.map((b) => [b.ip, b.until.getTime()]));
    this.detector.prune(started);
  }
}
