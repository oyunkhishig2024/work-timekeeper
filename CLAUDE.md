# Timekeeper Work — notes for contributors and AI assistants

- Start with `README.md`, then `docs/Timekeeper_Work_PRD.md` (what) and
  `docs/Timekeeper_Work_Architecture.md` (how). PRD section numbers (e.g. "PRD 6.4") are cited in
  code and tests.
- Package manager is **pnpm** (workspace); tasks run through **Turborepo** (`pnpm build|test|lint|typecheck`).
- Attendance business rules go in `packages/domain` (pure, framework-free) with tests. Do not copy
  rule logic into the API, worker, web or mobile code.
- Do not edit the PRD silently: requirement changes are recorded in its change log (Section 27).
- Database: SQL migrations in `apps/api/db/migrations` (see its README). Every tenant table is created with `apply_tenant_rls()`; never edit an applied migration. Database tests need `TEST_DATABASE_URL` (name must end in `_test`; the schema is rebuilt on each run) and are skipped without it.
- Auth: see `apps/api/src/auth/README.md`. Required secrets `JWT_SECRET` and `DATA_ENCRYPTION_KEY` have no defaults. Do not auto-fix `import type` in `apps/api` (NestJS DI needs value imports).
- Devices, QR and consent API: see `apps/api/src/devices/README.md`. Consent forms are PDFs (pdfkit, DejaVu font in `apps/api/assets/fonts`); the consent text is draft until legal approval.
- Organization, employees, lifecycle and data scope API: see `apps/api/src/employees/README.md` (Managers are limited to their assigned scope; there is no employee delete; employee code is a system-assigned 16-digit number; name is Овог + Нэр; rank (цол) and position (албан тушаал) are free text with separate effective-dated histories).
- Working week, holidays and shifts API: see `apps/api/src/schedule/README.md`. Reasons API: see `apps/api/src/reasons/README.md`. Report export (Excel/CSV/PDF): see `apps/api/src/exports/README.md`. Security (WAF, adaptive rate limiting, DDoS plan): see `docs/security/README.md` and `apps/api/src/security/README.md`; production runs behind a proxy, so `TRUST_PROXY` must be set correctly.
- Domain rules and the expectation function (`getExpectation`): see `packages/domain/README.md`. Add rules there with tests that cite the PRD section.
- Attendance core (events, `deriveStatus`, daily results, worker tick): see `apps/api/src/attendance/README.md`. Statuses are derived data; never edit `attendance_result` by hand, rebuild it with `POST /v1/attendance/recompute`.
- Abuse state stores (memory/Redis), the circuit breaker and Redis ops: see `apps/api/src/security/README.md`. Never copy rule logic into a store; stores only move state atomically. Detector methods are async; the middleware uses `detector.admit()` once per request. Redis tests start their own redis-server and skip if the binary is missing.
- Mobile app is intentionally not scaffolded yet (see `apps/mobile/README.md`).
- Before finishing a change run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
