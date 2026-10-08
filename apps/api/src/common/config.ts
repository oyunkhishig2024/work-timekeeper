import { z } from "zod";

const base64Key32 = z
  .string()
  .refine(
    (value) => Buffer.from(value, "base64").length === 32,
    "must be 32 bytes, base64-encoded",
  );

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z
    .string()
    .url()
    .default("postgres://timekeeper:timekeeper@localhost:5432/timekeeper"),
  /** Signs access tokens (HS256). Generate with: openssl rand -base64 48 */
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  /** Encrypts TOTP secrets at rest and keys recovery-code hashes. Generate with: openssl rand -base64 32 */
  DATA_ENCRYPTION_KEY: base64Key32,
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900), // PRD 15.2: <= 15 min
  /** Web admin sessions expire after this idle time (PRD 15.2: 30 min). */
  STAFF_SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).default(30),
  /** Mobile (employee) refresh tokens are long-lived but rotate on every use. */
  EMPLOYEE_SESSION_DAYS: z.coerce.number().int().min(1).default(30),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
  /** Per-IP rate limit for the auth endpoints. */
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  /**
   * Device attestation (Play Integrity / App Attest, PRD 6.7). "disabled" accepts registrations and records
   * them as UNVERIFIED (development, pilot spikes). "enforce" requires a real verifier, which is NOT built
   * yet (Phase 0 Spike 2): until then it rejects every registration with 503 ATTESTATION_UNAVAILABLE.
   */
  ATTESTATION_MODE: z.enum(["disabled", "enforce"]).default("disabled"),
  /** Local directory for uploaded files (consent scans) until the cloud object store is chosen. */
  STORAGE_DIR: z.string().default("./storage"),
  /** Default QR lifetimes in hours (PRD 5: configurable; PRD 21.1: replacement QR 24 h). */
  QR_ONBOARDING_HOURS: z.coerce.number().int().min(1).max(720).default(72),
  /**
   * How many reverse proxies sit in front of the API (a number of hops, e.g. 1 for nginx) or a comma-separated list of
   * trusted proxy addresses / CIDRs / keywords (`loopback`, `uniquelocal`). Decides which X-Forwarded-For entry is the
   * client IP, which rate limiting and bans depend on: too high lets a client spoof its IP, too low sees only the proxy.
   */
  TRUST_PROXY: z.string().default("1"),
  /** Adaptive abuse protection (behaviour-based IP throttle / temporary ban). */
  ABUSE_PROTECTION: z.enum(["on", "off"]).default("on"),
  /** Comma-separated IPs / CIDRs that are never throttled or banned (office, monitoring, load tests). */
  ABUSE_ALLOWLIST: z.string().default(""),
  /** Loopback is never banned (health checks, local tools); turn off only for tests of the protection itself. */
  ABUSE_ALLOW_LOOPBACK: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Score at which an IP is throttled / banned (see apps/api/src/security/README.md). */
  ABUSE_THROTTLE_SCORE: z.coerce.number().min(1).default(40),
  ABUSE_BAN_SCORE: z.coerce.number().min(2).default(100),
  /** Anonymous requests per minute an IP may make while throttled. */
  ABUSE_THROTTLE_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  /** Anonymous requests per 10 seconds that count as a flood signal, and the cap for authenticated traffic from one IP. */
  ABUSE_ANON_BURST_PER_10S: z.coerce.number().int().min(5).default(100),
  ABUSE_AUTH_BURST_PER_10S: z.coerce.number().int().min(10).default(400),
  /**
   * Shared abuse-protection state for several API instances (apps/api/src/security/README.md). Unset = in-process
   * memory (single instance). Example: redis://:password@127.0.0.1:6379
   */
  REDIS_URL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(
      z
        .string()
        .regex(/^rediss?:\/\//u, "must start with redis:// or rediss://")
        .optional(),
    ),
  /** Key prefix of the abuse state in Redis (use a different one per environment sharing a Redis). */
  ABUSE_REDIS_PREFIX: z.string().min(1).default("tk:abuse:"),
  /** Per Redis command timeout, consecutive failures that open the circuit breaker, and how long it stays open. */
  ABUSE_REDIS_TIMEOUT_MS: z.coerce.number().int().min(20).max(5000).default(200),
  ABUSE_REDIS_BREAKER_FAILURES: z.coerce.number().int().min(1).default(3),
  ABUSE_REDIS_BREAKER_COOLDOWN_SECONDS: z.coerce.number().min(0.05).default(15),
  /**
   * Web Push (VAPID) for Org Admin notifications. Generate keys once with `npx web-push generate-vapid-keys`. Without
   * the keys nothing is pushed; notifications still appear in the in-app inbox.
   */
  VAPID_PUBLIC_KEY: z.string().trim().optional(),
  VAPID_PRIVATE_KEY: z.string().trim().optional(),
  /** Contact for the push services: `mailto:ops@example.com` or an https URL. */
  VAPID_SUBJECT: z.string().trim().default("mailto:admin@localhost.invalid"),
  /**
   * Hosts (or `*.suffix` patterns) a push subscription may point to. The server posts to the subscription's URL, so only
   * the known browser push services are accepted (prevents using the API to reach internal addresses).
   */
  PUSH_ENDPOINT_HOSTS: z
    .string()
    .default(
      "fcm.googleapis.com,updates.push.services.mozilla.com,*.push.apple.com,*.notify.windows.com",
    ),
  QR_REPLACEMENT_HOURS: z.coerce.number().int().min(1).max(720).default(24),
});

export type AppConfig = z.infer<typeof envSchema>;

export const APP_CONFIG = Symbol("APP_CONFIG");

/** Parse and validate environment variables once at startup; fail fast on invalid config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
