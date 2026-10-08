import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import {
  auditActions,
  bearer,
  createEmployeeWithUser,
  createUser,
  type Harness,
  setupWorld,
  signConsentSql,
  signIn,
  startHarness,
} from "./harness";
import { AttestationVerifier } from "../../src/devices/attestation";

describe.skipIf(!hasDb)("devices and QR registration (PRD 5, 21)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const world = (opts: { consent?: boolean } = {}) => setupWorld(h, opts);
  const signConsent = (tenantId: string, employeeId: string) =>
    signConsentSql(h, tenantId, employeeId);

  const device = (qrToken: string, extra: object = {}) => ({
    qrToken,
    platform: "ANDROID",
    model: "Samsung A54",
    osVersion: "14",
    appVersion: "1.0.0",
    attestationKeyId: `key-${Math.random().toString(36).slice(2)}`,
    ...extra,
  });

  const register = (token: string, body: object) =>
    h.http().post("/v1/devices/register").set(bearer(token)).send(body);

  describe("QR codes", () => {
    it("HR creates a general QR; the token is shown once and never listed; payload carries no personal data", async () => {
      const w = await world();
      const res = await h
        .http()
        .post("/v1/qr/onboarding")
        .set(bearer(w.hrTokens.accessToken))
        .send({ label: "Төв салбар 10-р сар" });
      expect(res.status).toBe(201);
      expect(res.body.kind).toBe("ONBOARDING");
      expect(res.body.token).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);
      expect(res.body.qrPayload).toBe(`tkw://register?token=${encodeURIComponent(res.body.token)}`);
      expect(res.body.qrPayload.replace(res.body.token, "")).toBe("tkw://register?token=");

      const list = await h.http().get("/v1/qr").set(bearer(w.hrTokens.accessToken));
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain(res.body.token);
      const stored = await h.owner.query("SELECT token_hash FROM onboarding_qr WHERE id = $1", [
        res.body.id,
      ]);
      expect(stored.rows[0].token_hash).not.toContain(res.body.token.split(".")[1]);
      expect(await auditActions(h, w.tenant.id)).toContain("qr.created");
    });

    it("regenerating a shared QR cancels the old one and returns a working new one", async () => {
      const w = await world();
      const hr = bearer(w.hrTokens.accessToken);
      const old = (
        await h
          .http()
          .post("/v1/qr/onboarding")
          .set(hr)
          .send({ label: "Төв салбар", maxUses: 40, expiresInHours: 8 })
      ).body;
      const next = await h.http().post(`/v1/qr/${old.id}/regenerate`).set(hr).send({});
      expect(next.status).toBe(201);
      expect(next.body).toMatchObject({ kind: "ONBOARDING", maxUses: 40 });
      expect(next.body.id).not.toBe(old.id);
      expect(next.body.token).not.toBe(old.token);
      const stored = await h.owner.query("SELECT label FROM onboarding_qr WHERE id = $1", [
        next.body.id,
      ]);
      expect(stored.rows[0].label).toBe("Төв салбар");

      expect((await register(w.empTokens.accessToken, device(old.token))).body.code).toBe(
        "QR_CANCELLED",
      );
      expect((await register(w.empTokens.accessToken, device(next.body.token))).status).toBe(201);
      // only the new one is still open (the employee used it, so the list shows it with one use)
      const open = await h.http().get("/v1/qr").set(hr);
      expect(open.body.map((q: { id: string }) => q.id)).toEqual([next.body.id]);
      expect(await auditActions(h, w.tenant.id)).toContain("qr.regenerated");

      // an already cancelled QR, an unknown one and a replacement QR cannot be regenerated
      expect((await h.http().post(`/v1/qr/${old.id}/regenerate`).set(hr).send({})).status).toBe(
        404,
      );
      const replacement = (
        await h.http().post(`/v1/employees/${w.employee.id}/replacement-qr`).set(hr).send({})
      ).body;
      expect(
        (await h.http().post(`/v1/qr/${replacement.id}/regenerate`).set(hr).send({})).status,
      ).toBe(404);
      expect(
        (await h.http().post(`/v1/qr/${next.body.id}/regenerate`).set(hr).send({ bogus: 1 }))
          .status,
      ).toBe(400);
      // employees cannot regenerate
      expect(
        (
          await h
            .http()
            .post(`/v1/qr/${next.body.id}/regenerate`)
            .set(bearer(w.empTokens.accessToken))
            .send({})
        ).status,
      ).toBe(403);
    });

    it("only HR and Org Admin manage QR codes", async () => {
      const w = await world();
      const mgr = await createUser(h, w.tenant, { username: "mgr", role: "MANAGER" });
      const mgrTokens = await signIn(h, mgr);
      for (const token of [mgrTokens.accessToken, w.empTokens.accessToken]) {
        expect((await h.http().post("/v1/qr/onboarding").set(bearer(token)).send({})).status).toBe(
          403,
        );
        expect((await h.http().get("/v1/qr").set(bearer(token))).status).toBe(403);
      }
      expect((await h.http().post("/v1/qr/onboarding")).status).toBe(401);
    });

    it("cancelled, expired and unknown QR codes are rejected with clear reasons", async () => {
      const w = await world();
      const qr = (
        await h
          .http()
          .post("/v1/qr/onboarding")
          .set(bearer(w.hrTokens.accessToken))
          .send({ expiresInHours: 1 })
      ).body;

      expect((await register(w.empTokens.accessToken, device("x".repeat(40)))).body.code).toBe(
        "QR_INVALID",
      );

      const cancelled = (
        await h.http().post("/v1/qr/onboarding").set(bearer(w.hrTokens.accessToken)).send({})
      ).body;
      expect(
        (await h.http().post(`/v1/qr/${cancelled.id}/cancel`).set(bearer(w.hrTokens.accessToken)))
          .status,
      ).toBe(200);
      expect(
        (await h.http().post(`/v1/qr/${cancelled.id}/cancel`).set(bearer(w.hrTokens.accessToken)))
          .status,
      ).toBe(404);
      expect((await register(w.empTokens.accessToken, device(cancelled.token))).body.code).toBe(
        "QR_CANCELLED",
      );

      h.clock.advanceSeconds(3601);
      const fresh = await signIn(h, w.user);
      expect((await register(fresh.accessToken, device(qr.token))).body.code).toBe("QR_EXPIRED");
      expect(await auditActions(h, w.tenant.id)).toContain("qr.cancelled");
    });
  });

  describe("registration", () => {
    it("registers a device with a general QR, binds the session to it and reports it", async () => {
      const w = await world();
      const qr = (
        await h.http().post("/v1/qr/onboarding").set(bearer(w.hrTokens.accessToken)).send({})
      ).body;
      const res = await register(w.empTokens.accessToken, device(qr.token));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: "ACTIVE",
        replacedDeviceId: null,
        attestationState: "UNVERIFIED",
      });

      const bound = await h.owner.query(
        "SELECT device_id FROM auth_session WHERE user_id = $1 AND revoked_at IS NULL",
        [w.user.id],
      );
      expect(bound.rows.map((r) => r.device_id)).toContain(res.body.deviceId);
      const me = await h.http().get("/v1/devices/me").set(bearer(w.empTokens.accessToken));
      expect(me.body.device).toMatchObject({
        id: res.body.deviceId,
        status: "ACTIVE",
        model: "Samsung A54",
      });
      expect(me.body.consent).toBe("SIGNED");
      expect(await auditActions(h, w.tenant.id)).toContain("device.registered");

      const used = await h.owner.query("SELECT used_count FROM onboarding_qr WHERE id = $1", [
        qr.id,
      ]);
      expect(used.rows[0].used_count).toBe(1);
    });

    it("one general QR serves many employees, each at most once", async () => {
      const w = await world();
      const qr = (
        await h.http().post("/v1/qr/onboarding").set(bearer(w.hrTokens.accessToken)).send({})
      ).body;
      expect((await register(w.empTokens.accessToken, device(qr.token))).status).toBe(201);

      const second = await createEmployeeWithUser(h, w.tenant, "second");
      await signConsent(w.tenant.id, second.employee.id);
      const secondTokens = await signIn(h, second.user);
      expect((await register(secondTokens.accessToken, device(qr.token))).status).toBe(201);

      const limited = (
        await h
          .http()
          .post("/v1/qr/onboarding")
          .set(bearer(w.hrTokens.accessToken))
          .send({ maxUses: 1 })
      ).body;
      const third = await createEmployeeWithUser(h, w.tenant, "third");
      await signConsent(w.tenant.id, third.employee.id);
      const fourth = await createEmployeeWithUser(h, w.tenant, "fourth");
      await signConsent(w.tenant.id, fourth.employee.id);
      expect(
        (await register((await signIn(h, third.user)).accessToken, device(limited.token))).status,
      ).toBe(201);
      expect(
        (await register((await signIn(h, fourth.user)).accessToken, device(limited.token))).body
          .code,
      ).toBe("QR_USED_UP");
    });

    it("blocks registration until consent is signed, leaving the QR untouched (PRD 15.4 gate)", async () => {
      const w = await world({ consent: false });
      const qr = (
        await h.http().post("/v1/qr/onboarding").set(bearer(w.hrTokens.accessToken)).send({})
      ).body;
      const res = await register(w.empTokens.accessToken, device(qr.token));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("CONSENT_REQUIRED");
      expect(
        (await h.owner.query("SELECT used_count FROM onboarding_qr WHERE id = $1", [qr.id])).rows[0]
          .used_count,
      ).toBe(0);
      expect(
        (
          await h.owner.query("SELECT count(*)::int AS n FROM device WHERE employee_id = $1", [
            w.employee.id,
          ])
        ).rows[0].n,
      ).toBe(0);

      await signConsent(w.tenant.id, w.employee.id);
      expect((await register(w.empTokens.accessToken, device(qr.token))).status).toBe(201);
    });

    it("an Org Admin override QR allows registration without consent and is recorded; HR cannot issue one", async () => {
      const w = await world({ consent: false });
      const url = `/v1/employees/${w.employee.id}/replacement-qr`;
      const body = { consentOverrideReason: "Paper signed, record pending" };
      expect((await h.http().post(url).set(bearer(w.hrTokens.accessToken)).send(body)).status).toBe(
        403,
      );
      expect(
        (
          await h
            .http()
            .post(url)
            .set(bearer(w.adminTokens.accessToken))
            .send({ consentOverrideReason: "ok" })
        ).status,
      ).toBe(400);

      const qr = (await h.http().post(url).set(bearer(w.adminTokens.accessToken)).send(body)).body;
      const res = await register(w.empTokens.accessToken, device(qr.token));
      expect(res.status).toBe(201);
      const stored = await h.owner.query(
        "SELECT consent_override_reason, consent_override_by FROM device WHERE id = $1",
        [res.body.deviceId],
      );
      expect(stored.rows[0]).toMatchObject({
        consent_override_reason: body.consentOverrideReason,
        consent_override_by: w.admin.id,
      });
      expect(
        JSON.stringify(
          await h.owner
            .query(
              "SELECT after FROM audit_log WHERE action = 'device.registered' AND tenant_id = $1",
              [w.tenant.id],
            )
            .then((r) => r.rows),
        ),
      ).toContain("Paper signed");
    });

    it("only employee accounts can register; inactive employees cannot", async () => {
      const w = await world();
      const qr = (
        await h.http().post("/v1/qr/onboarding").set(bearer(w.hrTokens.accessToken)).send({})
      ).body;
      expect((await register(w.hrTokens.accessToken, device(qr.token))).status).toBe(403);
      await h.owner.query("UPDATE employee SET status = 'DISABLED' WHERE id = $1", [w.employee.id]);
      expect(
        (await h.http().get("/v1/devices/me").set(bearer(w.empTokens.accessToken))).status,
      ).toBe(200); // session still valid; account is not disabled
      expect((await register(w.empTokens.accessToken, device(qr.token))).body.code).toBe(
        "EMPLOYEE_INACTIVE",
      );
    });

    it("validates the request", async () => {
      const w = await world();
      const res = await register(w.empTokens.accessToken, {
        platform: "WINDOWS",
        qrToken: "short",
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("the same install key cannot be registered under two accounts (DEVICE_CONFLICT)", async () => {
      const w = await world();
      const qr = (
        await h.http().post("/v1/qr/onboarding").set(bearer(w.hrTokens.accessToken)).send({})
      ).body;
      expect(
        (
          await register(
            w.empTokens.accessToken,
            device(qr.token, { attestationKeyId: "same-key" }),
          )
        ).status,
      ).toBe(201);

      const other = await createEmployeeWithUser(h, w.tenant, "other");
      await signConsent(w.tenant.id, other.employee.id);
      const res = await register(
        (await signIn(h, other.user)).accessToken,
        device(qr.token, { attestationKeyId: "same-key" }),
      );
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("DEVICE_CONFLICT");
    });
  });

  describe("replacement and loss (PRD 21)", () => {
    it("a general QR cannot replace an existing device; a replacement QR does, atomically and once", async () => {
      const w = await world();
      const general = (
        await h.http().post("/v1/qr/onboarding").set(bearer(w.hrTokens.accessToken)).send({})
      ).body;
      const first = await register(w.empTokens.accessToken, device(general.token));
      expect(first.status).toBe(201);

      const newPhone = await signIn(h, w.user);
      const blocked = await register(newPhone.accessToken, device(general.token, {}));
      expect(blocked.status).toBe(409);
      expect(["DEVICE_ALREADY_REGISTERED", "QR_ALREADY_USED"]).toContain(blocked.body.code);

      const replacement = (
        await h
          .http()
          .post(`/v1/employees/${w.employee.id}/replacement-qr`)
          .set(bearer(w.hrTokens.accessToken))
          .send({})
      ).body;
      expect(replacement).toMatchObject({
        kind: "REPLACEMENT",
        employeeId: w.employee.id,
        maxUses: 1,
      });
      const swapped = await register(newPhone.accessToken, {
        ...device(replacement.token),
        model: "iPhone 15",
        platform: "IOS",
      });
      expect(swapped.status).toBe(201);
      expect(swapped.body.replacedDeviceId).toBe(first.body.deviceId);

      const old = await h.owner.query(
        "SELECT status, disabled_reason, replaced_by_device_id FROM device WHERE id = $1",
        [first.body.deviceId],
      );
      expect(old.rows[0]).toEqual({
        status: "REPLACED",
        disabled_reason: "REPLACED",
        replaced_by_device_id: swapped.body.deviceId,
      });
      // The old phone's session ended with the old device (database trigger); the new phone keeps working.
      expect(
        (await h.http().get("/v1/devices/me").set(bearer(w.empTokens.accessToken))).status,
      ).toBe(401);
      expect(
        (await h.http().get("/v1/devices/me").set(bearer(newPhone.accessToken))).body.device.id,
      ).toBe(swapped.body.deviceId);

      expect((await register(newPhone.accessToken, device(replacement.token))).body.code).toBe(
        "QR_USED_UP",
      );
      expect(await auditActions(h, w.tenant.id)).toContain("device.replaced");
      const list = await h
        .http()
        .get(`/v1/employees/${w.employee.id}/devices`)
        .set(bearer(w.hrTokens.accessToken));
      expect(list.body.map((d: { status: string }) => d.status).sort()).toEqual([
        "ACTIVE",
        "REPLACED",
      ]);
    });

    it("a replacement QR is only valid for its own employee", async () => {
      const w = await world();
      const other = await createEmployeeWithUser(h, w.tenant, "other2");
      await signConsent(w.tenant.id, other.employee.id);
      const qr = (
        await h
          .http()
          .post(`/v1/employees/${w.employee.id}/replacement-qr`)
          .set(bearer(w.hrTokens.accessToken))
          .send({})
      ).body;
      const res = await register((await signIn(h, other.user)).accessToken, device(qr.token));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("QR_NOT_FOR_YOU");
      expect(
        (
          await h
            .http()
            .post(`/v1/employees/00000000-0000-4000-8000-000000000000/replacement-qr`)
            .set(bearer(w.hrTokens.accessToken))
            .send({})
        ).status,
      ).toBe(404);
    });

    it("HR disabling a lost phone ends its sessions immediately (PRD 21.2); the employee can register again", async () => {
      const w = await world();
      const qr = (
        await h.http().post("/v1/qr/onboarding").set(bearer(w.hrTokens.accessToken)).send({})
      ).body;
      const reg = await register(w.empTokens.accessToken, device(qr.token));

      const bad = await h
        .http()
        .post(`/v1/devices/${reg.body.deviceId}/disable`)
        .set(bearer(w.hrTokens.accessToken))
        .send({ reason: "BROKEN" });
      expect(bad.status).toBe(400);
      const ok = await h
        .http()
        .post(`/v1/devices/${reg.body.deviceId}/disable`)
        .set(bearer(w.hrTokens.accessToken))
        .send({ reason: "LOST", note: "Утсаа алдсан" });
      expect(ok.status).toBe(200);
      expect(
        (
          await h
            .http()
            .post(`/v1/devices/${reg.body.deviceId}/disable`)
            .set(bearer(w.hrTokens.accessToken))
            .send({ reason: "LOST" })
        ).body.code,
      ).toBe("DEVICE_NOT_ACTIVE");
      expect(
        (await h.http().get("/v1/devices/me").set(bearer(w.empTokens.accessToken))).status,
      ).toBe(401);
      expect(await auditActions(h, w.tenant.id)).toContain("device.disabled");

      // A shared QR is for the first registration only: after a lost phone HR must issue a replacement QR.
      const shared = (
        await h.http().post("/v1/qr/onboarding").set(bearer(w.hrTokens.accessToken)).send({})
      ).body;
      const viaShared = await register((await signIn(h, w.user)).accessToken, device(shared.token));
      expect(viaShared.status).toBe(409);
      expect(viaShared.body.code).toBe("REPLACEMENT_QR_REQUIRED");
      expect(
        (await h.owner.query("SELECT used_count FROM onboarding_qr WHERE id = $1", [shared.id]))
          .rows[0].used_count,
      ).toBe(0);

      const again = (
        await h
          .http()
          .post(`/v1/employees/${w.employee.id}/replacement-qr`)
          .set(bearer(w.hrTokens.accessToken))
          .send({})
      ).body;
      expect(
        (await register((await signIn(h, w.user)).accessToken, device(again.token))).status,
      ).toBe(201);
    });
  });

  describe("attestation", () => {
    it("rejects a registration whose attestation fails", async () => {
      const w = await world();
      const qr = (
        await h.http().post("/v1/qr/onboarding").set(bearer(w.hrTokens.accessToken)).send({})
      ).body;
      const verifier = h.app.get(AttestationVerifier);
      const original = verifier.verifyRegistration.bind(verifier);
      verifier.verifyRegistration = async () => "FAILED";
      try {
        const res = await register(w.empTokens.accessToken, device(qr.token));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("ATTESTATION_FAILED");
      } finally {
        verifier.verifyRegistration = original;
      }
      expect((await register(w.empTokens.accessToken, device(qr.token))).status).toBe(201);
    });
  });

  describe("tenant isolation", () => {
    it("never touches another tenant's QR codes or devices", async () => {
      const a = await world();
      const b = await world();
      const qrB = (
        await h.http().post("/v1/qr/onboarding").set(bearer(b.hrTokens.accessToken)).send({})
      ).body;
      expect(
        (await h.http().post(`/v1/qr/${qrB.id}/cancel`).set(bearer(a.hrTokens.accessToken))).status,
      ).toBe(404);
      expect((await register(a.empTokens.accessToken, device(qrB.token))).body.code).toBe(
        "QR_INVALID",
      );

      const reg = await register(b.empTokens.accessToken, device(qrB.token));
      expect(
        (
          await h
            .http()
            .post(`/v1/devices/${reg.body.deviceId}/disable`)
            .set(bearer(a.hrTokens.accessToken))
            .send({ reason: "LOST" })
        ).status,
      ).toBe(404);
      expect(
        (
          await h
            .http()
            .get(`/v1/employees/${b.employee.id}/devices`)
            .set(bearer(a.hrTokens.accessToken))
        ).status,
      ).toBe(404);
    });
  });
});
