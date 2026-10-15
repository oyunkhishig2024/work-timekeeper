# Platform (Super Admin)

The Super Admin is the owner of the whole service (PRD 4). It is **not** a tenant user: its account is in `platform_user`, reachable only by the `platform_admin` database role, and it never belongs to an organization.

## Sign-in `/v1/platform/auth`

```
POST /login           { username, password }  → { status: "OK", tokens } | { status: "MFA_REQUIRED", challengeToken }
POST /totp/verify     { challengeToken, code } → tokens
POST /logout | GET /me | POST /password/change | POST /totp/setup | POST /totp/enable   (platform token)
```

- Token: HS256 with audience `timekeeper-platform` (tenant tokens use `timekeeper-api`), so a tenant token never opens a platform route and the other way round (`platform.test.ts`).
- A session is one `platform_session` row with a fixed lifetime (`PLATFORM_SESSION_MINUTES`, 60); there is no refresh token. Logout, a password change, an authenticator change or a console reset end it at once.
- Authenticator app is mandatory: a new account must change its password and enrol one before anything else works (`403 SETUP_REQUIRED`). No recovery codes: a lost phone is fixed from the server console.
- Same lockout (`LOGIN_MAX_FAILURES`, `LOGIN_LOCK_MINUTES`) and per-IP throttle as the staff sign-in. Every event is in `audit_log` with `tenant_id` NULL and `actor_role` `SUPER_ADMIN`.

## Console `cli/create-platform-user.ts`

```
node apps/api/dist/cli/create-platform-user.js --username onki --name "Onki"
node apps/api/dist/cli/create-platform-user.js --username onki --reset    # lost password or authenticator
```

## Organizations `/v1/platform` (all behind `PlatformGuard`)

| Route                                     | What                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /tenants`, `GET /tenants/:id`        | organizations with counts (active employees, staff accounts, last sign-in, last event) and, for one, its Organization Admins          |
| `POST /tenants`                           | creates the organization, its defaults and its first Organization Admin in **one transaction**; returns the admin's one-time password |
| `PATCH /tenants/:id`                      | rename (the code and time zone never change)                                                                                          |
| `POST /tenants/:id/suspend` \| `activate` | a suspended organization cannot sign in or refresh and its live sessions stop at once; nothing is deleted                             |
| `POST /tenants/:id/admins`                | another Organization Admin                                                                                                            |
| `POST /tenants/:id/admins/reset`          | `{ username, totp? }` new one-time password (and no authenticator) for an Organization Admin                                          |
| `GET /activity`                           | the Super Admin trail                                                                                                                 |

Rules to keep:

- **Counts only.** The Super Admin cannot read attendance data; PRD 15.2 requires the organization's own support-access grant for that, which is not built.
- A new organization starts with what `infra/deploy/baseline-310.sql` gives tenant 310 (`seedDefaults` in `platform-tenants.service.ts`); keep the two in step.
- Every route of a platform controller is `@Public()` (skips the tenant guard) **and** carries `PlatformGuard`; `platform.test.ts` checks the guard on the controller.
- The tenant `AuthGuard` and `refresh` check `tenant.status = 'ACTIVE'`.
