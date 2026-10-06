# Terraform

Infrastructure as code for the pilot (Singapore region; provider to be chosen after Phase 0,
Spike 3). Planned resources: managed PostgreSQL with point-in-time recovery, container service for
`api`, `worker` and `web`, private object storage, secrets manager, monitoring/alerts, a small
staging environment. See `docs/Timekeeper_Work_Architecture.md` Sections 11 and 25 of the PRD.
