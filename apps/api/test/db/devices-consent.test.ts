import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asTenant, connectOwner, createFixture, hasDb, type Fixture } from "./helpers";

/** SQLSTATE raised by the consent gate trigger (migration 0008). */
const CONSENT_REQUIRED = "TK001";

describe.skipIf(!hasDb)("devices, QR codes and consent (PRD 5, 15.4, 21)", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connectOwner();
  });
  afterAll(async () => {
    await client.end();
  });

  // ---------------------------------------------------------------- fixtures

  async function setup(): Promise<Fixture & { userId: string }> {
    const f = await createFixture(client);
    const user = await client.query<{ id: string }>(
      "INSERT INTO user_account (tenant_id, username, password_hash, role) VALUES ($1, 'hr', 'x', 'HR') RETURNING id",
      [f.tenantId],
    );
    await client.query(
      "INSERT INTO consent_text_version (tenant_id, version, body, active) VALUES ($1, 'v1', 'text', true)",
      [f.tenantId],
    );
    return { ...f, userId: user.rows[0]!.id };
  }

  const addConsent = (
    f: Fixture & { userId: string },
    status: "PRINTED" | "SIGNED" | "SUPERSEDED" | "WITHDRAWN",
    extra: { formCode?: string } = {},
  ) =>
    client.query<{ id: string }>(
      `INSERT INTO consent_record
         (tenant_id, employee_id, form_code, text_version, status, signed_on, received_at, withdrawn_on)
       VALUES ($1, $2, $3, 'v1', $4,
               CASE WHEN $4 = 'PRINTED' THEN NULL ELSE DATE '2026-10-01' END,
               CASE WHEN $4 = 'PRINTED' THEN NULL ELSE now() END,
               CASE WHEN $4 = 'WITHDRAWN' THEN DATE '2026-10-05' END)
       RETURNING id`,
      [f.tenantId, f.employeeId, extra.formCode ?? `F-${randomUUID().slice(0, 8)}`, status],
    );

  const addDevice = (
    f: Fixture,
    extra: { key?: string; status?: string; override?: string; overrideBy?: string } = {},
  ) =>
    client.query<{ id: string }>(
      `INSERT INTO device (tenant_id, employee_id, platform, model, os_version, attestation_key_id, status,
                           disabled_at, consent_override_reason, consent_override_by)
       VALUES ($1, $2, 'ANDROID', 'Samsung A54', '14', $3, $4,
               CASE WHEN $4 = 'ACTIVE' THEN NULL ELSE now() END, $5, $6)
       RETURNING id`,
      [
        f.tenantId,
        f.employeeId,
        extra.key ?? randomUUID(),
        extra.status ?? "ACTIVE",
        extra.override ?? null,
        extra.overrideBy ?? null,
      ],
    );

  const deviceStatus = async (id: string) =>
    (
      await client.query<{ status: string; disabled_reason: string | null }>(
        "SELECT status, disabled_reason FROM device WHERE id = $1",
        [id],
      )
    ).rows[0]!;

  // ---------------------------------------------------------------- consent gate

  describe("consent gate on device registration", () => {
    it("rejects a device when the employee has no signed consent", async () => {
      const f = await setup();
      await expect(addDevice(f)).rejects.toMatchObject({ code: CONSENT_REQUIRED });
      await addConsent(f, "PRINTED"); // printed but not signed is not enough
      await expect(addDevice(f)).rejects.toMatchObject({ code: CONSENT_REQUIRED });
    });

    it("accepts a device once consent is signed", async () => {
      const f = await setup();
      await addConsent(f, "SIGNED");
      await addDevice(f);
    });

    it("accepts a documented Org Admin override, but only with both reason and actor", async () => {
      const f = await setup();
      await addDevice(f, { override: "Paper signed, record pending", overrideBy: f.userId });
      const g = await setup();
      await expect(addDevice(g, { override: "Paper signed, record pending" })).rejects.toThrow(
        /check constraint/i,
      );
      await expect(addDevice(g, { override: "x", overrideBy: g.userId })).rejects.toThrow(
        /check constraint/i,
      );
    });

    it("also applies to registrations made as the runtime role", async () => {
      const f = await setup();
      await expect(
        asTenant(client, f.tenantId, () =>
          client.query(
            "INSERT INTO device (tenant_id, employee_id, platform) VALUES ($1, $2, 'IOS')",
            [f.tenantId, f.employeeId],
          ),
        ),
      ).rejects.toMatchObject({ code: CONSENT_REQUIRED });
    });
  });

  // ---------------------------------------------------------------- one active device

  describe("one active device per employee (PRD 5)", () => {
    it("blocks a second active device but allows it after the first is replaced", async () => {
      const f = await setup();
      await addConsent(f, "SIGNED");
      const first = await addDevice(f);
      await expect(addDevice(f)).rejects.toThrow(/unique/i);

      // Replacement workflow (PRD 21.1): retire the old device, register the new, link them.
      await client.query(
        "UPDATE device SET status = 'REPLACED', disabled_at = now(), disabled_reason = 'REPLACED' WHERE id = $1",
        [first.rows[0]!.id],
      );
      const second = await addDevice(f);
      await client.query("UPDATE device SET replaced_by_device_id = $2 WHERE id = $1", [
        first.rows[0]!.id,
        second.rows[0]!.id,
      ]);
      expect(await deviceStatus(first.rows[0]!.id)).toEqual({
        status: "REPLACED",
        disabled_reason: "REPLACED",
      });
    });

    it("keeps status and disabled_at consistent and only REPLACED devices can point to a successor", async () => {
      const f = await setup();
      await addConsent(f, "SIGNED");
      const d = await addDevice(f);
      await expect(
        client.query("UPDATE device SET status = 'DISABLED' WHERE id = $1", [d.rows[0]!.id]),
      ).rejects.toThrow(/check constraint/i);
      await expect(
        client.query("UPDATE device SET replaced_by_device_id = id WHERE id = $1", [d.rows[0]!.id]),
      ).rejects.toThrow(/check constraint/i);
    });

    it("the same install key cannot be registered under two accounts (DEVICE_CONFLICT)", async () => {
      const f = await setup();
      await addConsent(f, "SIGNED");
      await addDevice(f, { key: "shared-key" });
      const other = await client.query<{ id: string }>(
        `INSERT INTO employee (tenant_id, employee_no, full_name, department_id, primary_location_id)
         VALUES ($1, 'E-002', 'Second', $2, $3) RETURNING id`,
        [f.tenantId, f.departmentId, f.locationId],
      );
      await client.query(
        `INSERT INTO consent_record (tenant_id, employee_id, form_code, text_version, status, signed_on, received_at)
         VALUES ($1, $2, 'F-2', 'v1', 'SIGNED', DATE '2026-10-01', now())`,
        [f.tenantId, other.rows[0]!.id],
      );
      await expect(
        addDevice({ ...f, employeeId: other.rows[0]!.id }, { key: "shared-key" }),
      ).rejects.toThrow(/unique/i);
    });

    it("cannot reference another tenant's employee", async () => {
      const a = await setup();
      const b = await setup();
      await expect(
        client.query(
          "INSERT INTO device (tenant_id, employee_id, platform, consent_override_reason, consent_override_by) VALUES ($1, $2, 'IOS', 'override reason', $3)",
          [a.tenantId, b.employeeId, a.userId],
        ),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  // ---------------------------------------------------------------- automatic deactivation

  describe("automatic deactivation", () => {
    it("withdrawing consent disables the device and ends its sessions (PRD 15.4)", async () => {
      const f = await setup();
      const consent = await addConsent(f, "SIGNED");
      const device = await addDevice(f);
      const empUser = await client.query<{ id: string }>(
        "INSERT INTO user_account (tenant_id, username, password_hash, role, employee_id) VALUES ($1, 'emp1', 'x', 'EMPLOYEE', $2) RETURNING id",
        [f.tenantId, f.employeeId],
      );
      await client.query(
        "INSERT INTO auth_session (tenant_id, user_id, device_id, refresh_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')",
        [f.tenantId, empUser.rows[0]!.id, device.rows[0]!.id, randomUUID()],
      );

      // Done as the runtime role: the triggers must work under Row-Level Security.
      await asTenant(client, f.tenantId, async () => {
        await client.query(
          "UPDATE consent_record SET status = 'WITHDRAWN', withdrawn_on = DATE '2026-10-06' WHERE id = $1",
          [consent.rows[0]!.id],
        );
        const dev = await client.query("SELECT status, disabled_reason FROM device WHERE id = $1", [
          device.rows[0]!.id,
        ]);
        expect(dev.rows[0]).toEqual({ status: "DISABLED", disabled_reason: "CONSENT_WITHDRAWN" });
        const sessions = await client.query(
          "SELECT revoked_at FROM auth_session WHERE device_id = $1",
          [device.rows[0]!.id],
        );
        expect(sessions.rows[0].revoked_at).not.toBeNull();
      });
    });

    it("disabling or archiving the employee disables the device (PRD 12.2)", async () => {
      for (const status of ["DISABLED", "ARCHIVED"]) {
        const f = await setup();
        await addConsent(f, "SIGNED");
        const device = await addDevice(f);
        await client.query("UPDATE employee SET status = $2 WHERE id = $1", [f.employeeId, status]);
        expect(await deviceStatus(device.rows[0]!.id)).toEqual({
          status: "DISABLED",
          disabled_reason: "EMPLOYEE_DISABLED",
        });
      }
    });

    it("an HR 'disable device' (lost phone) ends sessions bound to it (PRD 21.2)", async () => {
      const f = await setup();
      await addConsent(f, "SIGNED");
      const device = await addDevice(f);
      const empUser = await client.query<{ id: string }>(
        "INSERT INTO user_account (tenant_id, username, password_hash, role, employee_id) VALUES ($1, 'emp2', 'x', 'EMPLOYEE', $2) RETURNING id",
        [f.tenantId, f.employeeId],
      );
      await client.query(
        "INSERT INTO auth_session (tenant_id, user_id, device_id, refresh_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')",
        [f.tenantId, empUser.rows[0]!.id, device.rows[0]!.id, randomUUID()],
      );
      await client.query(
        "UPDATE device SET status = 'DISABLED', disabled_at = now(), disabled_reason = 'LOST', disabled_by = $2 WHERE id = $1",
        [device.rows[0]!.id, f.userId],
      );
      const revoked = await client.query(
        "SELECT revoked_at FROM auth_session WHERE device_id = $1",
        [device.rows[0]!.id],
      );
      expect(revoked.rows[0].revoked_at).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------- consent records

  describe("consent records", () => {
    it("a signed or withdrawn form needs a signing date; printed forms must not have one", async () => {
      const f = await setup();
      await expect(
        client.query(
          "INSERT INTO consent_record (tenant_id, employee_id, form_code, text_version, status) VALUES ($1, $2, 'F-x', 'v1', 'SIGNED')",
          [f.tenantId, f.employeeId],
        ),
      ).rejects.toThrow(/check constraint/i);
      await expect(
        client.query(
          "INSERT INTO consent_record (tenant_id, employee_id, form_code, text_version, status, signed_on, received_at) VALUES ($1, $2, 'F-y', 'v1', 'WITHDRAWN', DATE '2026-10-01', now())",
          [f.tenantId, f.employeeId],
        ),
      ).rejects.toThrow(/check constraint/i);
    });

    it("only one SIGNED form per employee; a newer one supersedes the old", async () => {
      const f = await setup();
      const first = await addConsent(f, "SIGNED");
      await expect(addConsent(f, "SIGNED")).rejects.toThrow(/unique/i);
      await client.query("UPDATE consent_record SET status = 'SUPERSEDED' WHERE id = $1", [
        first.rows[0]!.id,
      ]);
      await addConsent(f, "SIGNED");
    });

    it("form codes are unique per tenant and the text version must exist", async () => {
      const f = await setup();
      await addConsent(f, "PRINTED", { formCode: "FORM-1" });
      await expect(addConsent(f, "PRINTED", { formCode: "FORM-1" })).rejects.toThrow(/unique/i);
      await expect(
        client.query(
          "INSERT INTO consent_record (tenant_id, employee_id, form_code, text_version) VALUES ($1, $2, 'F-z', 'v99')",
          [f.tenantId, f.employeeId],
        ),
      ).rejects.toThrow(/foreign key/i);
    });

    it("only one text version can be active per tenant", async () => {
      const f = await setup();
      await expect(
        client.query(
          "INSERT INTO consent_text_version (tenant_id, version, body, active) VALUES ($1, 'v2', 'text', true)",
          [f.tenantId],
        ),
      ).rejects.toThrow(/unique/i);
    });

    it("employee_consent_status reports NOT_REQUESTED, PRINTED, SIGNED and WITHDRAWN", async () => {
      const f = await setup();
      const status = async () =>
        asTenant(
          client,
          f.tenantId,
          async () =>
            (
              await client.query(
                "SELECT status, signed_text_version FROM employee_consent_status WHERE employee_id = $1",
                [f.employeeId],
              )
            ).rows[0],
        );
      expect(await status()).toEqual({ status: "NOT_REQUESTED", signed_text_version: null });
      const printed = await addConsent(f, "PRINTED");
      expect((await status()).status).toBe("PRINTED");
      await client.query(
        "UPDATE consent_record SET status = 'SIGNED', signed_on = DATE '2026-10-01', received_at = now() WHERE id = $1",
        [printed.rows[0]!.id],
      );
      expect(await status()).toEqual({ status: "SIGNED", signed_text_version: "v1" });
      await client.query(
        "UPDATE consent_record SET status = 'WITHDRAWN', withdrawn_on = DATE '2026-10-06' WHERE id = $1",
        [printed.rows[0]!.id],
      );
      expect((await status()).status).toBe("WITHDRAWN");
    });

    it("the status view respects tenant isolation", async () => {
      const a = await setup();
      const b = await setup();
      const rows = await asTenant(
        client,
        a.tenantId,
        async () => (await client.query("SELECT employee_id FROM employee_consent_status")).rows,
      );
      expect(rows).toEqual([{ employee_id: a.employeeId }]);
      expect(rows.some((r: { employee_id: string }) => r.employee_id === b.employeeId)).toBe(false);
    });
  });

  // ---------------------------------------------------------------- QR codes

  describe("onboarding and replacement QR codes", () => {
    const qr = (f: Fixture & { userId: string }, v: Record<string, unknown>) =>
      client.query<{ id: string }>(
        `INSERT INTO onboarding_qr (tenant_id, kind, employee_id, token_hash, expires_at, max_uses, used_count, created_by)
         VALUES ($1, $2, $3, $4, now() + interval '1 day', $5, $6, $7) RETURNING id`,
        [
          f.tenantId,
          v.kind,
          v.employeeId ?? null,
          randomUUID(),
          v.maxUses ?? null,
          v.usedCount ?? 0,
          f.userId,
        ],
      );

    it("a general ONBOARDING QR can serve many employees and carries no employee", async () => {
      const f = await setup();
      await qr(f, { kind: "ONBOARDING" });
      await qr(f, { kind: "ONBOARDING", maxUses: 50 });
      await expect(qr(f, { kind: "ONBOARDING", employeeId: f.employeeId })).rejects.toThrow(
        /check constraint/i,
      );
    });

    it("a REPLACEMENT QR is employee-specific and single use", async () => {
      const f = await setup();
      await qr(f, { kind: "REPLACEMENT", employeeId: f.employeeId, maxUses: 1 });
      await expect(qr(f, { kind: "REPLACEMENT", maxUses: 1 })).rejects.toThrow(/check constraint/i);
      await expect(
        qr(f, { kind: "REPLACEMENT", employeeId: f.employeeId, maxUses: 2 }),
      ).rejects.toThrow(/check constraint/i);
      await expect(qr(f, { kind: "REPLACEMENT", employeeId: f.employeeId })).rejects.toThrow(
        /check constraint/i,
      );
    });

    it("usage can never exceed max_uses; token hashes are unique", async () => {
      const f = await setup();
      await expect(qr(f, { kind: "ONBOARDING", maxUses: 2, usedCount: 3 })).rejects.toThrow(
        /check constraint/i,
      );
      const first = await client.query<{ token_hash: string }>(
        `INSERT INTO onboarding_qr (tenant_id, kind, token_hash, expires_at) VALUES ($1, 'ONBOARDING', 'same-hash', now() + interval '1 day') RETURNING token_hash`,
        [f.tenantId],
      );
      expect(first.rows[0]!.token_hash).toBe("same-hash");
      await expect(
        client.query(
          `INSERT INTO onboarding_qr (tenant_id, kind, token_hash, expires_at) VALUES ($1, 'ONBOARDING', 'same-hash', now() + interval '1 day')`,
          [f.tenantId],
        ),
      ).rejects.toThrow(/unique/i);
    });

    it("records which employee used a QR, at most once each", async () => {
      const f = await setup();
      await addConsent(f, "SIGNED");
      const device = await addDevice(f);
      const q = await qr(f, { kind: "ONBOARDING" });
      const use = () =>
        client.query(
          "INSERT INTO onboarding_qr_use (tenant_id, qr_id, employee_id, device_id) VALUES ($1, $2, $3, $4)",
          [f.tenantId, q.rows[0]!.id, f.employeeId, device.rows[0]!.id],
        );
      await use();
      await expect(use()).rejects.toThrow(/unique/i);
    });
  });
});
