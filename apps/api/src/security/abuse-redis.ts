import { Redis } from "ioredis";
import {
  type AbuseStateStore,
  decodeState,
  encodeState,
  type IpState,
  type Step,
} from "./abuse-state";

/**
 * Shares the per-IP judgement between API instances through Redis.
 *
 * ONE KEY PER IP (`<prefix><ip>`), a hash with two fields: `d` (the state as JSON) and `v` (a version number).
 * Every change is an optimistic compare-and-set: read `v` and `d` (1 round trip), run the detector's rule on the
 * copy, write back with a Lua script that stores the new state only if `v` is still the one that was read, and sets
 * the TTL (1 round trip). A lost race re-reads and re-applies the rule (up to `maxAttempts`). Because the rule is
 * applied to the freshly read state each time, no update is lost whatever the number of instances. Within one
 * process, updates of the same key are queued and applied together as ONE read-modify-write, so a flood from a single
 * address does not make one process fight itself.
 *
 * The Lua script is generic (it knows nothing about abuse rules): the rules exist only in abuse-detector.ts.
 */

/** Stores `ARGV[2]` as the new state only if the version is still `ARGV[1]`. Returns 1 if stored, 0 on a lost race. */
const CAS_LUA = `
local v = redis.call('HGET', KEYS[1], 'v')
if (v or '0') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'v', tostring(tonumber(ARGV[1]) + 1), 'd', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;

/** A problem that is not an outage (contention, overload): the caller serves the request from memory, no breaker count. */
export class SoftStoreError extends Error {}

interface CasClient {
  hmget(key: string, ...fields: string[]): Promise<Array<string | null>>;
  abuseCas(key: string, version: string, data: string, ttlMs: string): Promise<number>;
  del(key: string): Promise<number>;
  quit(): Promise<unknown>;
  disconnect(): void;
}

interface Op<R = unknown> {
  ttlFor: (state: IpState) => number;
  fn: (current: IpState | null) => Step<R>;
  resolve: (value: R) => void;
  reject: (error: unknown) => void;
}

export interface RedisStoreOptions {
  prefix: string;
  /** Per command timeout. */
  timeoutMs: number;
  maxAttempts?: number;
  /** Operations waiting on one key beyond this are served from memory instead. */
  maxQueuePerKey?: number;
}

export function createRedisClient(url: string, timeoutMs: number): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: Math.max(timeoutMs, 1000),
    commandTimeout: timeoutMs,
    // A command that cannot be sent right now fails at once instead of waiting for the connection: the caller falls back.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: (times) => Math.min(100 * times, 2000),
    reconnectOnError: () => false,
  });
  client.on("error", () => undefined); // reported through the circuit breaker, not as unhandled events
  client.defineCommand("abuseCas", { numberOfKeys: 1, lua: CAS_LUA });
  return client;
}

export class RedisStateStore implements AbuseStateStore {
  readonly kind = "redis" as const;
  private readonly client: CasClient;
  private readonly prefix: string;
  private readonly maxAttempts: number;
  private readonly maxQueue: number;
  private readonly queues = new Map<string, { ops: Op[]; running: boolean }>();

  constructor(
    client: Redis | CasClient,
    private readonly options: RedisStoreOptions,
  ) {
    this.client = client as unknown as CasClient;
    this.prefix = options.prefix;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.maxQueue = options.maxQueuePerKey ?? 256;
  }

  update<R>(
    key: string,
    ttlFor: (state: IpState) => number,
    fn: (current: IpState | null) => Step<R>,
  ): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      let queue = this.queues.get(key);
      if (!queue) {
        queue = { ops: [], running: false };
        this.queues.set(key, queue);
      }
      if (queue.ops.length >= this.maxQueue) {
        reject(new SoftStoreError("too many pending updates for one address"));
        return;
      }
      queue.ops.push({ ttlFor, fn, resolve, reject } as Op);
      if (!queue.running) void this.drain(key, queue);
    });
  }

  async get(key: string): Promise<IpState | null> {
    const [, data] = await this.client.hmget(this.prefix + key, "v", "d");
    return decodeState(data);
  }

  /** Removes the state of one address (operator tooling and tests). */
  async delete(key: string): Promise<void> {
    await this.client.del(this.prefix + key);
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  private async drain(key: string, queue: { ops: Op[]; running: boolean }): Promise<void> {
    queue.running = true;
    try {
      while (queue.ops.length > 0) {
        const batch = queue.ops.splice(0);
        try {
          await this.runBatch(key, batch);
        } catch (error) {
          for (const op of batch) op.reject(error);
        }
      }
    } finally {
      queue.running = false;
      this.queues.delete(key);
    }
  }

  /** Applies every queued rule step to ONE freshly read state and stores the result with a compare-and-set. */
  private async runBatch(key: string, batch: Op[]): Promise<void> {
    const redisKey = this.prefix + key;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const [version, data] = await this.client.hmget(redisKey, "v", "d");
      let state = decodeState(data);
      let write: IpState | null = null;
      let remove = false;
      const results: unknown[] = [];
      for (const op of batch) {
        const step = op.fn(state);
        results.push(step.result);
        if (step.remove) {
          remove = true;
          write = null;
          state = null;
        } else if (step.state) {
          remove = false;
          write = step.state;
          state = step.state;
        }
      }
      if (!write && !remove) return this.finish(batch, results);
      if (remove) {
        // A lift: drop the key. Not versioned on purpose; the next writer starts from nothing.
        await this.client.del(redisKey);
        return this.finish(batch, results);
      }
      const ttl = Math.max(1, ...batch.map((op) => op.ttlFor(write!)));
      const stored = await this.client.abuseCas(
        redisKey,
        version ?? "0",
        encodeState(write!),
        String(ttl),
      );
      if (stored === 1) return this.finish(batch, results);
      // Lost the race against another instance: re-read and apply the same steps to the newer state.
      await new Promise((r) => setTimeout(r, Math.random() * (1 + attempt) * 2));
    }
    throw new SoftStoreError(`state of one address kept changing (${this.maxAttempts} attempts)`);
  }

  private finish(batch: Op[], results: unknown[]): void {
    batch.forEach((op, i) => op.resolve(results[i]));
  }
}

// ------------------------------------------------------------------ never take the API down

export interface BreakerOptions {
  /** Consecutive failures that open the circuit. */
  failures: number;
  /** Milliseconds the circuit stays open (memory is used) before Redis is tried again. */
  cooldownMs: number;
  log: (line: Record<string, unknown>) => void;
  now?: () => number;
}

/**
 * Wraps the Redis store. A failed or slow Redis call is served from `fallback` (in-process memory) at once, so the
 * request is judged on this instance's own view and never fails. After `failures` consecutive failures the circuit
 * opens: Redis is not called at all for `cooldownMs`, then ONE call probes it. Logs `security.redis_unavailable`
 * and `security.redis_recovered` once per change of state.
 */
export class ResilientStateStore implements AbuseStateStore {
  readonly kind = "redis" as const;
  private consecutiveFailures = 0;
  private openUntil = 0;
  private unavailable = false;
  private readonly now: () => number;

  constructor(
    private readonly primary: AbuseStateStore,
    private readonly fallback: AbuseStateStore,
    private readonly options: BreakerOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  /** True while Redis is considered down (requests are judged from local memory). */
  get degraded(): boolean {
    return this.unavailable;
  }

  get size(): number | undefined {
    return this.fallback.size;
  }

  prune(now: number): void {
    this.fallback.prune?.(now);
  }

  async update<R>(
    key: string,
    ttlFor: (state: IpState) => number,
    fn: (current: IpState | null) => Step<R>,
  ): Promise<R> {
    if (!this.allowCall()) return this.fallback.update(key, ttlFor, fn);
    try {
      const result = await this.primary.update(key, ttlFor, fn);
      this.succeeded();
      return result;
    } catch (error) {
      this.failed(error);
      return this.fallback.update(key, ttlFor, fn);
    }
  }

  async get(key: string): Promise<IpState | null> {
    if (!this.allowCall()) return this.fallback.get(key);
    try {
      const result = await this.primary.get(key);
      this.succeeded();
      return result;
    } catch (error) {
      this.failed(error);
      return this.fallback.get(key);
    }
  }

  async close(): Promise<void> {
    await this.primary.close?.();
  }

  private allowCall(): boolean {
    const now = this.now();
    if (now < this.openUntil) return false;
    if (this.openUntil !== 0 && this.consecutiveFailures >= this.options.failures) {
      // Cooldown over: let this one call probe Redis; the others stay on memory until it answers.
      this.openUntil = now + this.options.cooldownMs;
    }
    return true;
  }

  private succeeded(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    if (this.unavailable) {
      this.unavailable = false;
      this.options.log({ event: "security.redis_recovered" });
    }
  }

  private failed(error: unknown): void {
    if (error instanceof SoftStoreError) return; // contention or overload, not an outage
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.failures) {
      this.openUntil = this.now() + this.options.cooldownMs;
      if (!this.unavailable) {
        this.unavailable = true;
        this.options.log({
          event: "security.redis_unavailable",
          reason: error instanceof Error ? error.message : String(error),
          fallback: "in-process memory",
          retryInSeconds: this.options.cooldownMs / 1000,
        });
      }
    }
  }
}

export interface SharedStoreOptions {
  url: string;
  prefix: string;
  timeoutMs: number;
  failures: number;
  cooldownMs: number;
  log: (line: Record<string, unknown>) => void;
  now?: () => number;
}

/** Redis state with the in-process `memory` store as fallback. `connect()` waits at most `waitMs` for Redis. */
export function createSharedStore(
  memory: AbuseStateStore,
  options: SharedStoreOptions,
): { store: ResilientStateStore; connect: (waitMs: number) => Promise<void> } {
  const client = createRedisClient(options.url, options.timeoutMs);
  const primary = new RedisStateStore(client, {
    prefix: options.prefix,
    timeoutMs: options.timeoutMs,
  });
  const store = new ResilientStateStore(primary, memory, {
    failures: options.failures,
    cooldownMs: options.cooldownMs,
    log: options.log,
    now: options.now,
  });
  return {
    store,
    // Do not hold the start-up for a Redis that is down: requests are judged from memory until it answers.
    connect: async (waitMs) => {
      await Promise.race([
        client.connect().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, waitMs).unref()),
      ]);
    },
  };
}
