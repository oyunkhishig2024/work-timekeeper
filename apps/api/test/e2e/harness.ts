import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { Client } from "pg";
import { AppModule } from "../../src/app.module";
import { Clock } from "../../src/common/clock";
import { PasswordService } from "../../src/auth/password.service";
import { SecretBox } from "../../src/auth/secret-box";
import { generateTotpSecret, totpCode } from "../../src/auth/totp";
import { connectOwner } from "../db/helpers";

/** A clock tests can move forward (lockout expiry, TOTP steps, token expiry). */
export class TestClock extends Clock {
  current = new Date();
  now(): Date {
    return new Date(this.current);
  }
  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

export interface Harness {
  app: INestApplication;
  clock: TestClock;
  owner: Client;
  passwords: PasswordService;
  box: SecretBox;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const clock = new TestClock();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix("v1");
  await app.init();
  const owner = await connectOwner();
  return {
    app,
    clock,
    owner,
    passwords: module.get(PasswordService),
    box: module.get(SecretBox),
    http: () => request(app.getHttpServer()),
    close: async () => {
      await app.close();
      await owner.end();
    },
  };
}

export interface TestUser {
  id: string;
  tenantId: string;
  orgCode: string;
  username: string;
  password: string;
  role: "ORG_ADMIN" | "HR" | "MANAGER";
  totpSecret?: string;
}

let counter = 0;

export async function createTenant(h: Harness): Promise<{ id: string; code: string }> {
  counter += 1;
  const code = `org${Date.now().toString(36)}${counter}`;
  const { rows } = await h.owner.query<{ id: string }>(
    "INSERT INTO tenant (code, name) VALUES ($1, $1) RETURNING id",
    [code],
  );
  return { id: rows[0]!.id, code };
}

export async function createUser(
  h: Harness,
  tenant: { id: string; code: string },
  opts: {
    username: string;
    role: TestUser["role"];
    password?: string;
    mustChangePassword?: boolean;
    totp?: boolean;
  },
): Promise<TestUser> {
  const password = opts.password ?? "Sup3r-secret passphrase";
  const totpSecret = opts.totp ? generateTotpSecret() : undefined;
  const { rows } = await h.owner.query<{ id: string }>(
    `INSERT INTO user_account
       (tenant_id, username, display_name, password_hash, role, must_change_password, totp_enabled, totp_secret_enc)
     VALUES ($1, $2, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      tenant.id,
      opts.username,
      await h.passwords.hash(password),
      opts.role,
      opts.mustChangePassword ?? false,
      Boolean(totpSecret),
      totpSecret ? h.box.encrypt(totpSecret) : null,
    ],
  );
  return {
    id: rows[0]!.id,
    tenantId: tenant.id,
    orgCode: tenant.code,
    username: opts.username,
    password,
    role: opts.role,
    totpSecret,
  };
}

export const login = (
  h: Harness,
  u: Pick<TestUser, "orgCode" | "username" | "password">,
  password = u.password,
) => h.http().post("/v1/auth/login").send({ orgCode: u.orgCode, username: u.username, password });

/** Full sign-in including the TOTP step when the account has one. Returns the token response body. */
export async function signIn(h: Harness, user: TestUser) {
  const first = await login(h, user);
  if (first.body.status === "MFA_REQUIRED") {
    // Use the next step so it cannot collide with a code already used in this test.
    h.clock.advanceSeconds(30);
    const second = await h
      .http()
      .post("/v1/auth/totp/verify")
      .send({
        challengeToken: first.body.challengeToken,
        code: totpCode(user.totpSecret!, h.clock.now().getTime()),
      });
    return second.body as TokenBody;
  }
  return first.body.tokens as TokenBody;
}

export interface TokenBody {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  requires: string[];
  user: { id: string; role: string };
  recoveryCodes?: string[];
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function auditActions(h: Harness, tenantId: string): Promise<string[]> {
  const { rows } = await h.owner.query<{ action: string }>(
    "SELECT action FROM audit_log WHERE tenant_id = $1 ORDER BY id",
    [tenantId],
  );
  return rows.map((r) => r.action);
}
