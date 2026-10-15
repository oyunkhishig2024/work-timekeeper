import type { Request } from "express";

export type PlatformLimit = "PASSWORD_CHANGE" | "TOTP_SETUP";

export interface PlatformContext {
  userId: string;
  username: string;
  sessionId: string;
  limited: PlatformLimit[];
}

export interface PlatformRequest extends Request {
  platform?: PlatformContext;
}

export interface PlatformUserRow {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  status: "ACTIVE" | "DISABLED";
  must_change_password: boolean;
  totp_enabled: boolean;
  totp_secret_enc: string | null;
  totp_last_step: string | null;
  failed_login_count: number;
  locked_until: Date | null;
  temp_password_expires_at: Date | null;
}

export const PLATFORM_USER_COLUMNS = `id, username, display_name, password_hash, status, must_change_password,
  totp_enabled, totp_secret_enc, totp_last_step, failed_login_count, locked_until, temp_password_expires_at`;

export interface PlatformTokens {
  tokenType: "Bearer";
  accessToken: string;
  /** Seconds until the session ends. */
  expiresIn: number;
  user: { id: string; username: string; displayName: string | null };
  /** Non-empty until the Super Admin finishes the listed steps; every other route answers 403 SETUP_REQUIRED. */
  requires: PlatformLimit[];
}
