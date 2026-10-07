import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../common/config";
import { Clock } from "../common/clock";
import { ApiError, forbidden } from "../common/api-error";
import { mapDbError } from "../common/db-errors";
import { DatabaseService, type Db } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { hashTenantToken, newTenantToken } from "../auth/token.service";
import { AttestationVerifier } from "./attestation";

export interface CreatedQr {
  id: string;
  kind: "ONBOARDING" | "REPLACEMENT";
  employeeId: string | null;
  /** The secret carried by the QR. Returned only once, at creation; only its hash is stored. */
  token: string;
  /** What to encode in the QR image. No personal data (PRD 5). */
  qrPayload: string;
  expiresAt: Date;
  maxUses: number | null;
}

export interface RegisterInput {
  qrToken: string;
  platform: "ANDROID" | "IOS";
  model?: string;
  osVersion?: string;
  appVersion?: string;
  attestationKeyId?: string;
  publicKey?: string;
  attestationToken?: string;
}

interface QrRow {
  id: string;
  kind: "ONBOARDING" | "REPLACEMENT";
  employee_id: string | null;
  expires_at: Date;
  max_uses: number | null;
  used_count: number;
  cancelled_at: Date | null;
  consent_override_reason: string | null;
  consent_override_by: string | null;
}

const qrPayload = (token: string): string => `tkw://register?token=${encodeURIComponent(token)}`;

@Injectable()
export class DevicesService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly attestation: AttestationVerifier,
  ) {}

  // ------------------------------------------------------------------ QR codes (HR / Org Admin)

  /** General QR that can onboard many employees until it expires or is cancelled (PRD 5). */
  async createOnboardingQr(
    auth: AuthContext,
    input: { label?: string; expiresInHours?: number; maxUses?: number },
    meta: RequestMeta,
  ): Promise<CreatedQr> {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const created = await this.insertQr(tx, auth, {
        kind: "ONBOARDING",
        employeeId: null,
        label: input.label,
        hours: input.expiresInHours ?? this.config.QR_ONBOARDING_HOURS,
        maxUses: input.maxUses ?? null,
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "qr.created",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "onboarding_qr",
        entityId: created.id,
        after: { kind: "ONBOARDING", expiresAt: created.expiresAt, maxUses: created.maxUses },
        ...meta,
      });
      return created;
    });
  }

  /**
   * Employee-specific, single-use QR for a new phone (PRD 21.1) — also usable for a first registration.
   * Only an Org Admin may attach a consent override (PRD 15.4).
   */
  async createReplacementQr(
    auth: AuthContext,
    employeeId: string,
    input: { expiresInHours?: number; consentOverrideReason?: string },
    meta: RequestMeta,
  ): Promise<CreatedQr> {
    if (input.consentOverrideReason !== undefined && auth.role !== "ORG_ADMIN") {
      throw forbidden("Only an Organization Admin can override the consent requirement.");
    }
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const employee = await tx.query<{ status: string }>(
        "SELECT status FROM employee WHERE id = $1",
        [employeeId],
      );
      if (!employee.rows[0]) throw new ApiError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
      if (employee.rows[0].status !== "ACTIVE") {
        throw new ApiError(409, "EMPLOYEE_INACTIVE", "The employee is not active.");
      }
      const created = await this.insertQr(tx, auth, {
        kind: "REPLACEMENT",
        employeeId,
        hours: input.expiresInHours ?? this.config.QR_REPLACEMENT_HOURS,
        maxUses: 1,
        consentOverrideReason: input.consentOverrideReason,
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "qr.created",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "onboarding_qr",
        entityId: created.id,
        after: {
          kind: "REPLACEMENT",
          employeeId,
          expiresAt: created.expiresAt,
          consentOverride: input.consentOverrideReason ?? null,
        },
        ...meta,
      });
      return created;
    });
  }

  /** QR codes that can still be used. The secret token is never returned here. */
  async listOpenQr(auth: AuthContext) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT q.id, q.kind, q.employee_id AS "employeeId", e.full_name AS "employeeName", q.label,
                q.expires_at AS "expiresAt", q.max_uses AS "maxUses", q.used_count AS "usedCount",
                q.created_at AS "createdAt"
           FROM onboarding_qr q LEFT JOIN employee e ON e.tenant_id = q.tenant_id AND e.id = q.employee_id
          WHERE q.cancelled_at IS NULL AND q.expires_at > $1 AND (q.max_uses IS NULL OR q.used_count < q.max_uses)
          ORDER BY q.created_at DESC`,
        [this.clock.now()],
      );
      return rows;
    });
  }

  async cancelQr(auth: AuthContext, id: string, meta: RequestMeta): Promise<{ id: string }> {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const { rowCount } = await tx.query(
        "UPDATE onboarding_qr SET cancelled_at = $2, cancelled_by = $3 WHERE id = $1 AND cancelled_at IS NULL",
        [id, this.clock.now(), auth.userId],
      );
      if (rowCount === 0)
        throw new ApiError(404, "QR_NOT_FOUND", "QR code not found or already cancelled.");
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "qr.cancelled",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "onboarding_qr",
        entityId: id,
        ...meta,
      });
      return { id };
    });
  }

  // ------------------------------------------------------------------ registration (employee's phone)

  /**
   * PRD 5 / 21.1: the employee, signed in on the phone, scans a QR to register it. A previous device is
   * replaced atomically. Everything happens in one transaction, so a rejected registration (for example
   * missing consent) leaves the old device and the QR untouched.
   */
  async register(auth: AuthContext, input: RegisterInput, meta: RequestMeta) {
    if (!auth.employeeId) throw forbidden("Only employee accounts can register a device.");
    const employeeId = auth.employeeId;
    const attestationState = await this.attestation.verifyRegistration({
      platform: input.platform,
      keyId: input.attestationKeyId,
      publicKey: input.publicKey,
      token: input.attestationToken,
    });
    if (attestationState === "FAILED") {
      throw new ApiError(403, "ATTESTATION_FAILED", "The device or app could not be verified.");
    }

    try {
      return await this.db.withTenant(auth.tenantId, async (tx) => {
        const now = this.clock.now();
        const qr = await this.lockUsableQr(tx, input.qrToken, auth, now);

        const employee = await tx.query<{ status: string }>(
          "SELECT status FROM employee WHERE id = $1 FOR UPDATE",
          [employeeId],
        );
        if (employee.rows[0]?.status !== "ACTIVE") {
          throw new ApiError(403, "EMPLOYEE_INACTIVE", "The employee is not active.");
        }

        const current = await tx.query<{ id: string }>(
          "SELECT id FROM device WHERE employee_id = $1 AND status = 'ACTIVE' FOR UPDATE",
          [employeeId],
        );
        const previous = current.rows[0];
        if (previous && qr.kind === "ONBOARDING" && !(await this.onboardingMayReplace(tx))) {
          throw new ApiError(
            409,
            "DEVICE_ALREADY_REGISTERED",
            "This employee already has a registered device. Ask HR for a replacement QR code.",
          );
        }
        if (previous) {
          await tx.query(
            `UPDATE device SET status = 'REPLACED', disabled_at = $2, disabled_reason = 'REPLACED' WHERE id = $1`,
            [previous.id, now],
          );
        }

        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO device
             (tenant_id, employee_id, platform, model, os_version, app_version, attestation_key_id, public_key,
              attestation_state, registered_at, consent_override_reason, consent_override_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [
            auth.tenantId,
            employeeId,
            input.platform,
            input.model ?? null,
            input.osVersion ?? null,
            input.appVersion ?? null,
            input.attestationKeyId ?? null,
            input.publicKey ?? null,
            attestationState,
            now,
            qr.consent_override_reason,
            qr.consent_override_by,
          ],
        );
        const deviceId = inserted.rows[0]!.id;
        if (previous) {
          await tx.query("UPDATE device SET replaced_by_device_id = $2 WHERE id = $1", [
            previous.id,
            deviceId,
          ]);
        }

        await tx.query("UPDATE onboarding_qr SET used_count = used_count + 1 WHERE id = $1", [
          qr.id,
        ]);
        await tx.query(
          "INSERT INTO onboarding_qr_use (tenant_id, qr_id, employee_id, device_id, used_at) VALUES ($1, $2, $3, $4, $5)",
          [auth.tenantId, qr.id, employeeId, deviceId, now],
        );
        // From now on this login session belongs to the device; if the device is disabled the session ends.
        await tx.query("UPDATE auth_session SET device_id = $2 WHERE id = $1", [
          auth.sessionId,
          deviceId,
        ]);

        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          action: previous ? "device.replaced" : "device.registered",
          actorUserId: auth.userId,
          actorRole: auth.role,
          entityType: "device",
          entityId: deviceId,
          after: {
            employeeId,
            platform: input.platform,
            model: input.model ?? null,
            osVersion: input.osVersion ?? null,
            qrId: qr.id,
            qrKind: qr.kind,
            replacedDeviceId: previous?.id ?? null,
            attestationState,
            consentOverride: qr.consent_override_reason,
          },
          ...meta,
        });
        return {
          deviceId,
          status: "ACTIVE" as const,
          replacedDeviceId: previous?.id ?? null,
          registeredAt: now,
          attestationState,
        };
      });
    } catch (error) {
      throw mapDbError(error);
    }
  }

  /** The signed-in employee's current device and whether it is still valid. */
  async myDevice(auth: AuthContext) {
    if (!auth.employeeId) throw forbidden("Only employee accounts have a device.");
    const employeeId = auth.employeeId;
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const device = await tx.query(
        `SELECT id, platform, model, os_version AS "osVersion", status, registered_at AS "registeredAt"
           FROM device WHERE employee_id = $1 ORDER BY registered_at DESC LIMIT 1`,
        [employeeId],
      );
      const consent = await tx.query<{ status: string }>(
        "SELECT status FROM employee_consent_status WHERE employee_id = $1",
        [employeeId],
      );
      return {
        device: device.rows[0] ?? null,
        consent: consent.rows[0]?.status ?? "NOT_REQUESTED",
      };
    });
  }

  // ------------------------------------------------------------------ HR actions

  /** Lost or stolen phone: the device stops being accepted and its sessions end at once (PRD 21.2). */
  async disableDevice(
    auth: AuthContext,
    deviceId: string,
    input: { reason: "LOST" | "STOLEN" | "OTHER"; note?: string },
    meta: RequestMeta,
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const found = await tx.query<{ employee_id: string; status: string }>(
        "SELECT employee_id, status FROM device WHERE id = $1 FOR UPDATE",
        [deviceId],
      );
      const device = found.rows[0];
      if (!device) throw new ApiError(404, "DEVICE_NOT_FOUND", "Device not found.");
      if (device.status !== "ACTIVE")
        throw new ApiError(409, "DEVICE_NOT_ACTIVE", "The device is already inactive.");

      await tx.query(
        `UPDATE device
            SET status = 'DISABLED', disabled_at = $2, disabled_reason = $3, disabled_note = $4, disabled_by = $5
          WHERE id = $1`,
        [deviceId, this.clock.now(), input.reason, input.note ?? null, auth.userId],
      );
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "device.disabled",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "device",
        entityId: deviceId,
        after: { employeeId: device.employee_id, reason: input.reason },
        ...meta,
      });
      return { id: deviceId, status: "DISABLED" as const };
    });
  }

  async listForEmployee(auth: AuthContext, employeeId: string) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const employee = await tx.query("SELECT 1 FROM employee WHERE id = $1", [employeeId]);
      if (employee.rowCount === 0)
        throw new ApiError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
      const { rows } = await tx.query(
        `SELECT id, platform, model, os_version AS "osVersion", app_version AS "appVersion", status,
                attestation_state AS "attestationState", registered_at AS "registeredAt",
                disabled_at AS "disabledAt", disabled_reason AS "disabledReason",
                replaced_by_device_id AS "replacedByDeviceId",
                consent_override_reason AS "consentOverrideReason"
           FROM device WHERE employee_id = $1 ORDER BY registered_at DESC`,
        [employeeId],
      );
      return rows;
    });
  }

  // ------------------------------------------------------------------ helpers

  private async insertQr(
    tx: Db,
    auth: AuthContext,
    v: {
      kind: "ONBOARDING" | "REPLACEMENT";
      employeeId: string | null;
      label?: string;
      hours: number;
      maxUses: number | null;
      consentOverrideReason?: string;
    },
  ): Promise<CreatedQr> {
    const token = newTenantToken(auth.tenantId);
    const expiresAt = new Date(this.clock.now().getTime() + v.hours * 3_600_000);
    const override = v.consentOverrideReason ?? null;
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO onboarding_qr
         (tenant_id, kind, employee_id, token_hash, label, expires_at, max_uses, created_by,
          consent_override_reason, consent_override_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        auth.tenantId,
        v.kind,
        v.employeeId,
        token.hash,
        v.label ?? null,
        expiresAt,
        v.maxUses,
        auth.userId,
        override,
        override ? auth.userId : null,
      ],
    );
    return {
      id: rows[0]!.id,
      kind: v.kind,
      employeeId: v.employeeId,
      token: token.token,
      qrPayload: qrPayload(token.token),
      expiresAt,
      maxUses: v.maxUses,
    };
  }

  private async lockUsableQr(tx: Db, token: string, auth: AuthContext, now: Date): Promise<QrRow> {
    const { rows } = await tx.query<QrRow>(
      `SELECT id, kind, employee_id, expires_at, max_uses, used_count, cancelled_at,
              consent_override_reason, consent_override_by
         FROM onboarding_qr WHERE token_hash = $1 FOR UPDATE`,
      [hashTenantToken(token)],
    );
    const qr = rows[0];
    if (!qr) throw new ApiError(400, "QR_INVALID", "This QR code is not valid.");
    if (qr.cancelled_at) throw new ApiError(400, "QR_CANCELLED", "This QR code was cancelled.");
    if (qr.expires_at <= now) throw new ApiError(400, "QR_EXPIRED", "This QR code has expired.");
    if (qr.max_uses !== null && qr.used_count >= qr.max_uses) {
      throw new ApiError(400, "QR_USED_UP", "This QR code has already been used.");
    }
    if (qr.employee_id !== null && qr.employee_id !== auth.employeeId) {
      throw new ApiError(
        403,
        "QR_NOT_FOR_YOU",
        "This QR code was issued for a different employee.",
      );
    }
    const already = await tx.query(
      "SELECT 1 FROM onboarding_qr_use WHERE qr_id = $1 AND employee_id = $2",
      [qr.id, auth.employeeId],
    );
    if ((already.rowCount ?? 0) > 0) {
      throw new ApiError(409, "QR_ALREADY_USED", "You have already used this QR code.");
    }
    return qr;
  }

  /** Tenant setting: may a general QR replace an existing device? Off by default (PRD 21.1). */
  private async onboardingMayReplace(tx: Db): Promise<boolean> {
    const { rows } = await tx.query<{ value: unknown }>(
      "SELECT value FROM tenant_setting WHERE key = 'onboarding_qr_may_replace_device'",
    );
    return rows[0]?.value === true;
  }
}
