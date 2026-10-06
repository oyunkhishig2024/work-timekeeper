import type { Request } from "express";
import type { LimitReason } from "./token.service";
import type { Role } from "./roles";

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: Role;
  sessionId: string;
  /** Steps the user must complete before normal use (change password, set up TOTP). */
  limited: LimitReason[];
}

export interface AuthedRequest extends Request {
  auth?: AuthContext;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface UserRow {
  id: string;
  tenant_id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  role: Role;
  employee_id: string | null;
  status: "ACTIVE" | "DISABLED";
  must_change_password: boolean;
  totp_enabled: boolean;
  totp_secret_enc: string | null;
  totp_last_step: string | null;
  failed_login_count: number;
  locked_until: Date | null;
}

export const USER_COLUMNS = `id, tenant_id, username, display_name, password_hash, role, employee_id, status,
  must_change_password, totp_enabled, totp_secret_enc, totp_last_step, failed_login_count, locked_until`;

export interface AuthTokens {
  tokenType: "Bearer";
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  refreshToken: string;
  user: { id: string; username: string; displayName: string | null; role: Role };
  /** Non-empty until the user finishes the listed steps; most endpoints answer 403 SETUP_REQUIRED. */
  requires: LimitReason[];
}
