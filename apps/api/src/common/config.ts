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
});

export type AppConfig = z.infer<typeof envSchema>;

export const APP_CONFIG = Symbol("APP_CONFIG");

/** Parse and validate environment variables once at startup; fail fast on invalid config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
