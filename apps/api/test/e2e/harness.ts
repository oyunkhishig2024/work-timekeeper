import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { Client } from "pg";
import { AppModule } from "../../src/app.module";
import { applyAbuseProtection } from "../../src/security/apply";
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

export async function startHarness(
  options: { trustProxy?: number | string | string[] } = {},
): Promise<Harness> {
  const clock = new TestClock();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix("v1");
  if (options.trustProxy !== undefined) {
    // Tests send X-Forwarded-For to play different client addresses; the test client itself is the loopback proxy.
    (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set(
      "trust proxy",
      options.trustProxy,
    );
  }
  applyAbuseProtection(app);
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
  role: "ORG_ADMIN" | "HR" | "MANAGER" | "EMPLOYEE";
  employeeId?: string;
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
    employeeId?: string;
  },
): Promise<TestUser> {
  const password = opts.password ?? "Sup3r-secret passphrase";
  const totpSecret = opts.totp ? generateTotpSecret() : undefined;
  const { rows } = await h.owner.query<{ id: string }>(
    `INSERT INTO user_account
       (tenant_id, username, display_name, password_hash, role, must_change_password, totp_enabled, totp_secret_enc, employee_id)
     VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      tenant.id,
      opts.username,
      await h.passwords.hash(password),
      opts.role,
      opts.mustChangePassword ?? false,
      Boolean(totpSecret),
      totpSecret ? h.box.encrypt(totpSecret) : null,
      opts.employeeId ?? null,
    ],
  );
  return {
    id: rows[0]!.id,
    tenantId: tenant.id,
    orgCode: tenant.code,
    username: opts.username,
    password,
    role: opts.role,
    employeeId: opts.employeeId,
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

// ---------------------------------------------------------------- organization fixtures

const orgCache = new Map<string, { departmentId: string; locationId: string; count: number }>();

/** Creates an employee (with the tenant's single test department and location, created on first use). */
export async function createEmployee(
  h: Harness,
  tenant: { id: string },
  opts: { name?: string; status?: string } = {},
): Promise<{ id: string; name: string }> {
  let org = orgCache.get(tenant.id);
  if (!org) {
    const d = await h.owner.query<{ id: string }>(
      "INSERT INTO department (tenant_id, name) VALUES ($1, 'Хүний нөөц') RETURNING id",
      [tenant.id],
    );
    const l = await h.owner.query<{ id: string }>(
      "INSERT INTO location (tenant_id, name, lat, lng, radius_m) VALUES ($1, 'Төв салбар', 47.9, 106.9, 150) RETURNING id",
      [tenant.id],
    );
    org = { departmentId: d.rows[0]!.id, locationId: l.rows[0]!.id, count: 0 };
    orgCache.set(tenant.id, org);
  }
  org.count += 1;
  const name = opts.name ?? `Бадам Гэндэн ${org.count}`;
  const { rows } = await h.owner.query<{ id: string }>(
    `INSERT INTO employee (tenant_id, employee_no, full_name, department_id, primary_location_id, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      tenant.id,
      `E-${String(org.count).padStart(3, "0")}`,
      name,
      org.departmentId,
      org.locationId,
      opts.status ?? "ACTIVE",
    ],
  );
  return { id: rows[0]!.id, name };
}

/** An employee with a login account (role EMPLOYEE), ready to sign in. */
export async function createEmployeeWithUser(
  h: Harness,
  tenant: { id: string; code: string },
  username: string,
) {
  const employee = await createEmployee(h, tenant);
  const user = await createUser(h, tenant, { username, role: "EMPLOYEE", employeeId: employee.id });
  return { employee, user };
}

export async function createConsentText(
  h: Harness,
  tenant: { id: string },
  opts: { version?: string; body?: string; draft?: boolean; active?: boolean } = {},
): Promise<string> {
  const { rows } = await h.owner.query<{ id: string }>(
    `INSERT INTO consent_text_version (tenant_id, version, body, is_draft, active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      tenant.id,
      opts.version ?? "v1",
      opts.body ?? SAMPLE_CONSENT_BODY,
      opts.draft ?? false,
      opts.active ?? true,
    ],
  );
  return rows[0]!.id;
}

export const SAMPLE_CONSENT_BODY = [
  "Байршлын мэдээлэл боловсруулах, ирц бүртгэхийн тулд өгөх сайн дурын зөвшөөрлийн хуудас",
  "1. Би Timekeeper Work ирцийн системд өөрийн гар утсаар ирцээ автоматаар бүртгүүлэхийг сайн дураараа зөвшөөрч байна.",
  "2. Ямар мэдээлэл цуглуулах вэ: миний утас ажлын байрны тодорхойлсон бүс руу орсон/гарсан цаг.",
  "3. Зорилго: зөвхөн ирц тооцох. Бусад зорилгоор ашиглахгүй. Өндөр Үүлэн Өргөн Ү Ө ү ө.",
].join("\n");

/** Marks consent as signed directly in the database (for tests that are not about the consent flow). */
export async function signConsentSql(
  h: Harness,
  tenantId: string,
  employeeId: string,
): Promise<void> {
  await h.owner.query(
    `INSERT INTO consent_record (tenant_id, employee_id, form_code, text_version, status, signed_on, received_at)
     VALUES ($1, $2, $3, 'v1', 'SIGNED', DATE '2026-10-01', now())`,
    [tenantId, employeeId, `T-${Math.random().toString(36).slice(2, 10)}`],
  );
}

/**
 * A tenant with an Org Admin, an HR user (both with TOTP, signed in), an active consent text and one employee
 * who can sign in. `consent: false` leaves the employee without signed consent.
 */
export async function setupWorld(h: Harness, opts: { consent?: boolean; text?: boolean } = {}) {
  const tenant = await createTenant(h);
  if (opts.text !== false) await createConsentText(h, tenant);
  const hr = await createUser(h, tenant, { username: "hr", role: "HR", totp: true });
  const admin = await createUser(h, tenant, { username: "admin", role: "ORG_ADMIN", totp: true });
  const hrTokens = await signIn(h, hr);
  const adminTokens = await signIn(h, admin);
  const { employee, user } = await createEmployeeWithUser(h, tenant, "badam");
  if (opts.consent !== false) await signConsentSql(h, tenant.id, employee.id);
  const empTokens = await signIn(h, user);
  return { tenant, hr, admin, hrTokens, adminTokens, employee, user, empTokens };
}
