# Authentication (PRD 15.2)

All endpoints are under `/v1`. Errors are RFC 7807 `application/problem+json` with a stable `code`.

## Flows

```
POST /auth/login         { orgCode, username, password }
   → 200 { status: "OK", tokens }                       staff without TOTP, employees, or Managers
   → 200 { status: "MFA_REQUIRED", challengeToken }     Org Admin / HR with an authenticator
POST /auth/totp/verify   { challengeToken, code | recoveryCode }  → tokens
POST /auth/refresh       { refreshToken }               → new tokens (rotation; replay revokes the family)
POST /auth/logout        (Bearer)                       → 204
GET  /auth/me            (Bearer)
POST /auth/password/change { currentPassword, newPassword }  → fresh tokens; all older sessions end
POST /auth/totp/setup    (Bearer)  → { secret, otpauthUri }   scan in Google Authenticator
POST /auth/totp/enable   { code }  → tokens + 8 recovery codes (shown once)

POST /users                       Org Admin creates an HR or Manager user (optional employeeId: their own employee record) → one-time temporary password
PUT  /users/:id/employee          Org Admin links a staff account (Org Admin, HR, Manager) to the person's own employee record, or unlinks (null): they then register a phone and record their own attendance (PRD 4); one login per employee
POST /users/:id/reset-password    Org Admin → HR/Manager/Employee; HR → Employee
POST /users/:id/totp-reset        Org Admin (lost phone)
```

`tokens` = `{ tokenType, accessToken, expiresIn, refreshToken, user, requires }`.
`requires` lists steps still to finish (`PASSWORD_CHANGE`, `TOTP_SETUP`). While it is non-empty only
`/auth/*` account endpoints work; everything else answers `403 SETUP_REQUIRED`.

## Rules implemented

- Login takes the **organization code**: resolve tenant → set tenant context → read the user (Architecture 9.3).
  Unknown org, unknown user, disabled user and wrong password all answer the same `401 INVALID_CREDENTIALS`
  and cost the same time (dummy hash check).
- Passwords: Argon2id (19 MiB, 2 iterations), min 10 characters, not common, not containing the username.
- Lockout: 5 consecutive failures (password or code) lock the account for 15 minutes (`423 ACCOUNT_LOCKED`).
  Per-IP rate limit on the auth routes (10/min by default).
- Access token: JWT HS256, 15 minutes. Every request also checks the session and user in the database, so
  disabling a user or revoking a session takes effect immediately (PRD 12.2).
- Refresh token: opaque `<tenantId>.<random>`, SHA-256 hash stored, rotated on every use. Staff sessions
  expire after 30 minutes idle (sliding); employee sessions after 30 days. Replaying a used token revokes
  the whole token family and is audited.
- TOTP (RFC 6238, SHA-1, 30 s, 6 digits): required for Org Admin and HR, optional for Manager. Seeds are
  stored AES-256-GCM encrypted; a code cannot be reused (last accepted step stored); ±1 step drift allowed.
- Recovery codes: 8 per enrolment, 80 bits each, stored as keyed HMAC, single use.
- Every authentication event is written to `audit_log` in the same transaction.

## Not done yet (deliberate)

- Super Admin (platform) login — Release 1 creates tenants and the first Org Admin by script
  (`pnpm --filter @timekeeper/api cli:create-user`, PRD 17.1).
- Device-bound mobile tokens and the employee invite/activation flow — they come with the devices module.
- Breached-password check against the full Have I Been Pwned list: needs an external call (a new entry in
  the PRD 15.3 foreign-processors register). A built-in denylist of very common passwords is used meanwhile.
- Progressive (escalating) lockout: the lock is a fixed 15 minutes.
- Absolute maximum session age for staff (idle expiry only).
- Password-reset by one-time code to a verified email/phone (admin/HR-assisted reset exists).

## Staff who are also employees (PRD 4, v1.32)

Org Admin, HR and Manager are employees too: their account may carry `employee_id` (migration `0028`; an EMPLOYEE account still always has one, and one account per employee). With the link they can `POST /devices/register`, `/events`, `/heartbeat` and read `/me/attendance` from the phone, with the same two-step login as on the web (TOTP for Org Admin and HR). Once the phone is registered the session bound to it lasts `EMPLOYEE_SESSION_DAYS` like an employee's; a web session stays short (`STAFF_SESSION_IDLE_MINUTES`). Without the link these routes answer `403 EMPLOYEE_ONLY`. Linking or unlinking ends the account's phone sessions. Disabling the employee also disables the linked login.
