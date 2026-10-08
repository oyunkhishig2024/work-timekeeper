# Devices, QR codes and consent API (PRD 5, 15.4, 21)

Roles: **HR** and **Org Admin** manage QR codes, devices and consent; only the **Org Admin** manages consent texts and
may attach a consent override. **Employees** register their own phone. Managers have no access. All routes are
under `/v1`. Rules that must never be bypassed are also enforced by database triggers (see
`db/migrations/README.md`).

## QR codes

| Route                                                                            | Who           |                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /qr/onboarding` `{label?, expiresInHours?, maxUses?}`                      | HR, Org Admin | Shared QR for **first registration only**, many employees (default 72 h; may be printed or shown on a screen). Returns `token` and `qrPayload` **once**               |
| `POST /qr/:id/regenerate` `{expiresInHours?}`                                    | HR, Org Admin | Cancels a shared QR and returns a new one (same label and use limit); the old code stops working at once. `404 QR_NOT_FOUND` for replacement, cancelled or unknown QR |
| `POST /employees/:id/replacement-qr` `{expiresInHours?, consentOverrideReason?}` | HR, Org Admin | Employee-specific, single use (default 24 h). Also valid for a first registration. `consentOverrideReason` (≥ 5 chars): **Org Admin only**                            |
| `GET /qr`                                                                        | HR, Org Admin | Open QR codes (never the token)                                                                                                                                       |
| `POST /qr/:id/cancel`                                                            | HR, Org Admin |                                                                                                                                                                       |

The QR payload is `tkw://register?token=<tenantId>.<random>`; only a SHA-256 hash is stored; it holds no personal data.

## Registration (employee, signed in on the phone)

`POST /devices/register` `{qrToken, platform, model?, osVersion?, appVersion?, attestationKeyId?, publicKey?, attestationToken?}`

In one transaction: check the QR (`QR_INVALID | QR_CANCELLED | QR_EXPIRED | QR_USED_UP | QR_NOT_FOR_YOU | QR_ALREADY_USED`),
the employee is active, replace any current device (**only a replacement QR may**: a shared QR is refused for an employee with any device history — `DEVICE_ALREADY_REGISTERED` while a device is active, `REPLACEMENT_QR_REQUIRED` after a lost, disabled or replaced one), insert the new device,
count the QR use, bind the current session to the device. A missing signed consent answers
`409 CONSENT_REQUIRED` and **nothing changes** (old device and QR untouched). The same install key under two
accounts answers `409 DEVICE_CONFLICT`.

`GET /devices/me` — the employee's current device and consent state.

## Device management

`POST /devices/:id/disable` `{reason: LOST|STOLEN|OTHER, note?}` — the device stops being accepted and its sessions end at once.
`GET /employees/:id/devices` — history (active, replaced, disabled).

## Consent

| Route                                                                                                      | Who                                             |                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /consent/texts` · `POST /consent/texts` · `POST /consent/texts/:id/activate`                          | list: HR/Admin; create, activate: **Org Admin** | One active text per tenant; `isDraft` texts print with a "DRAFT" banner and **cannot be printed in production**                                                                                                                               |
| `POST /consent/print` `{employeeIds[≤500]}`                                                                | HR, Org Admin                                   | **PDF**, one A4 page per employee, form code as text and QR. Reprinting an unsigned form reuses its code; already-signed employees are skipped (`X-Consent-Printed` / `X-Consent-Skipped` headers); nothing to print → `409 NOTHING_TO_PRINT` |
| `POST /consent/records/mark-signed` `{formCode, signedOn}`                                                 | HR, Org Admin                                   | "Consent received"; a newer form supersedes the old one (re-consent)                                                                                                                                                                          |
| `POST /employees/:id/consent/withdraw` `{withdrawnOn, note?}`                                              | HR, Org Admin                                   | Device disabled and sessions ended (database trigger); employee flagged **manual attendance**                                                                                                                                                 |
| `GET /employees/:id/consent`                                                                               | HR, Org Admin                                   | State, records, `reconsentRequired`                                                                                                                                                                                                           |
| `GET /consent/overview?status&limit&offset`                                                                | HR, Org Admin                                   | Counts per state (+ `RECONSENT_REQUIRED`) and employees                                                                                                                                                                                       |
| `PUT /consent/records/:id/scan` (raw `application/pdf`, `image/jpeg`, `image/png`, ≤ 10 MB) · `GET …/scan` | HR, Org Admin                                   | The type is decided from the file content; viewing is audited                                                                                                                                                                                 |

Load a consent text from a file (for example the draft in `docs/consent/`):
`node dist/cli/load-consent-text.js --org 310 --version consent-v1-draft --file ../../docs/consent/consent-v1-draft.mn.txt --draft --activate`

## Not done yet (deliberate)

- **Real device attestation** (Play Integrity / App Attest verification, Phase 0 Spike 2). `ATTESTATION_MODE=disabled`
  (default) records registrations as `UNVERIFIED`; `enforce` currently rejects everything with
  `503 ATTESTATION_UNAVAILABLE` so it cannot be mistaken for real enforcement. A `FAILED` verdict is already honoured.
- Cloud object storage for scans (local disk `STORAGE_DIR` for now) and virus scanning.
- HR scoping by location/department (HR sees the whole tenant for now).
- Device Readiness report (PRD 21.3) and bulk consent printing by department/location filters (the caller passes employee ids).
- Heartbeat and event upload with the device-bound session (next module: events).
