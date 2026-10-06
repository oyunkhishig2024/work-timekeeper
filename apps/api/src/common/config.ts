import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z
    .string()
    .url()
    .default("postgres://timekeeper:timekeeper@localhost:5432/timekeeper"),
});

export type AppConfig = z.infer<typeof envSchema>;

/** Parse and validate environment variables once at startup; fail fast on invalid config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
