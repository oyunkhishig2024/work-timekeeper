-- Up Migration
-- Device attestation result, and Org Admin consent override carried by an employee-specific QR.
-- PRD 6.7 (attestation), 15.4 (consent gate override).

ALTER TABLE device
  ADD COLUMN attestation_state text NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (attestation_state IN ('OK', 'FAILED', 'UNVERIFIED', 'UNAVAILABLE'));

-- An Org Admin can issue an employee-specific single-use QR that allows registration before the signed
-- consent form is recorded. The reason and the admin are stored on the QR and copied to the device.
ALTER TABLE onboarding_qr
  ADD COLUMN consent_override_reason text,
  ADD COLUMN consent_override_by uuid,
  ADD FOREIGN KEY (tenant_id, consent_override_by) REFERENCES user_account (tenant_id, id),
  ADD CONSTRAINT onboarding_qr_override_pair_chk
    CHECK ((consent_override_reason IS NULL) = (consent_override_by IS NULL)),
  ADD CONSTRAINT onboarding_qr_override_reason_chk
    CHECK (consent_override_reason IS NULL OR length(btrim(consent_override_reason)) >= 5),
  ADD CONSTRAINT onboarding_qr_override_kind_chk
    CHECK (consent_override_reason IS NULL OR kind = 'REPLACEMENT');

-- Down Migration
ALTER TABLE onboarding_qr
  DROP CONSTRAINT onboarding_qr_override_kind_chk,
  DROP CONSTRAINT onboarding_qr_override_reason_chk,
  DROP CONSTRAINT onboarding_qr_override_pair_chk,
  DROP CONSTRAINT onboarding_qr_tenant_id_consent_override_by_fkey,
  DROP COLUMN consent_override_by,
  DROP COLUMN consent_override_reason;
ALTER TABLE device DROP COLUMN attestation_state;
