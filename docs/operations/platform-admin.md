# Super Admin (platform owner)

The Super Admin manages organizations: create one, suspend or reactivate it, add or reset its Organization Admin. It cannot see attendance data.

## First time: create the Super Admin (server console)

```bash
cd ~/work-timekeeper
docker compose --env-file infra/deploy/.env -f infra/deploy/docker-compose.yml exec api \
  node apps/api/dist/cli/create-platform-user.js --username onki --name "Onki"
```

It prints a one-time password. Open `https://<your site>/platform/login`, sign in, choose a new password (10+ characters) and scan the QR code with an authenticator app. Nothing else works until both are done.

## Lost password or authenticator phone

Same command with `--reset` (new one-time password, authenticator removed, all sessions ended):

```bash
docker compose --env-file infra/deploy/.env -f infra/deploy/docker-compose.yml exec api \
  node apps/api/dist/cli/create-platform-user.js --username onki --reset
```

## Adding an organization

**Платформ → + Байгууллага нэмэх.** Fill in the name, a short code (letters, digits, dashes; people type it when signing in; it never changes), the time zone and the first Organization Admin. The page shows that admin's one-time password once; give it to them. They sign in with the organization code, choose a new password and set up the authenticator. The organization starts with the default absence reasons, attendance rules, a Monday-Friday 08:30-17:30 week and a DRAFT consent text (replace it after legal approval).

## Suspending

**Дэлгэрэнгүй → Түдгэлзүүлэх** stops every sign-in of that organization at once, phones included. Data stays. **Дахин идэвхжүүлэх** brings it back.

## Good to know

- A Super Admin session lasts 60 minutes, then sign in again.
- The **Үйл ажиллагаа** tab lists sign-ins and every action; the same rows are in the audit log.
- Optional hardening: restrict `/platform` and `/v1/platform` to your own IP address in `infra/deploy/Caddyfile`.
