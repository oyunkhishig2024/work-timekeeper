# Timekeeper Work — notes for contributors and AI assistants

- Start with `README.md`, then `docs/Timekeeper_Work_PRD.md` (what) and
  `docs/Timekeeper_Work_Architecture.md` (how). PRD section numbers (e.g. "PRD 6.4") are cited in
  code and tests.
- Package manager is **pnpm** (workspace); tasks run through **Turborepo** (`pnpm build|test|lint|typecheck`).
- Attendance business rules go in `packages/domain` (pure, framework-free) with tests. Do not copy
  rule logic into the API, worker, web or mobile code.
- Do not edit the PRD silently: requirement changes are recorded in its change log (Section 27).
- Mobile app is intentionally not scaffolded yet (see `apps/mobile/README.md`).
- Before finishing a change run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
