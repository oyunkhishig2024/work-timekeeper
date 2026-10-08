# Admin web app (Next.js)

Early build: sign-in, the dashboard (Хянах самбар) and the Org Admin notifications page. Daily attendance, employees, roster,
reports, QR and settings screens are still to come (the clickable prototype shows the intended design).

## Run

```
pnpm --filter @timekeeper/web dev          # http://localhost:3000
API_ORIGIN=http://localhost:3001           # where /v1/* is forwarded (default), see next.config.ts
```

The browser talks only to this app; `/v1/*` is forwarded to the API (rewrite), so there is no CORS. In production nginx routes
`/v1` to the API directly.

## Sign-in (`src/lib/session.ts`)

Organization code + username + password, then the TOTP code for accounts that have it. The access token is kept in memory, the
refresh token in `sessionStorage` (a reload keeps you signed in, closing the tab ends the session). A 401 triggers one shared
token refresh and a retry (`src/lib/api.ts`). Hardening still to do: move the refresh token to an httpOnly cookie behind a
backend-for-frontend, so page scripts never see it.

## Dashboard (`/dashboard`, PRD 7, 8)

Open to Org Admin, HR and Manager (the API limits the numbers to the caller's data scope). All state is in the URL
(`?date=&status=&location=&department=&by=`), so the back button and links work.

- Header with the organization name (from `GET /v1/auth/me`, which also gives the organization's own "today" and time zone) and
  date navigation: previous day, today, next day, date picker.
- **Ажиллах ёстой** card (everyone expected: on time + late + excused + no show + not yet due) and four quick cards: Цагтаа, Хоцорсон,
  Шалтгаантай, Ирээгүй, with counts and shares. Every card opens the list behind it.
- Notes under the total: nobody expected that day, worked on a day off, missing configuration, "⚑ N days have an event waiting for
  review" (PRD 6.7, the counts may change), hand-corrected days (PRD 6.9).
- **Салбараар / Нэгжээр**: per branch or department the total, on-time rate (`212 / 220`), a stacked bar and one pill per status
  (count and share); a pill opens the list for that branch or department.
- **List**: rank, full name, position, department, branch, status and an explanation (arrival time and minutes late, the reason,
  "no record, no reason given", ...), with "Засварласан" and "⚑ шалгах" marks. Chips switch the status inside the same scope.
- Today's numbers refresh every minute (the worker moves people from "not yet due" to "no show" at the cut-off).
- Numbers come from `GET /v1/attendance/summary`, lists from `GET /v1/attendance/daily` (`status=EXPECTED` = the total). The web only
  formats; no attendance rule is repeated here.

## Web Push (`public/sw.js`, `src/lib/push.ts`, `src/components/push-card.tsx`)

Server side: `apps/api/src/notifications/README.md`. Browser side:

- `/sw.js` is a plain service worker (served with `Cache-Control: no-cache` and `Service-Worker-Allowed: /`). It only shows push
  messages, opens the right page on click and asks open pages to re-register when the browser replaces a subscription. It has
  **no fetch handler and caches nothing**. Links from a notification are same-origin paths only; unreadable payloads still produce a
  generic notification (a push must always be visible).
- `/notifications` has the settings card and the inbox. **Асаах** asks for permission (from a click, as Safari requires),
  subscribes with the server's VAPID key and sends the subscription to `POST /v1/push/subscriptions`. A subscription made for a
  different server key is replaced. On every visit the page re-sends the existing subscription (the server upserts), which repairs a
  replaced or taken-over subscription. **Унтраах** unsubscribes in the browser and on the server; **Туршилтын мэдэгдэл** sends a test.
- States shown: unsupported browser, iPhone/iPad that must first be added to the home screen (`manifest.webmanifest`), server without
  VAPID keys, permission denied, off, on. A push service that does not answer within 20 s gives an error instead of a stuck button.

## Tests

`pnpm --filter @timekeeper/web test`: dashboard helpers (`attendance.ts`: dates, explanations, bar widths, URL state), push helpers (`push.ts`) and the service worker, which runs in a fake worker scope
(`test/sw.test.ts`: payloads, link safety, click handling, lifecycle).

Checked by hand in headless Chromium against a real API (dashboard with two branches and every status: cards, branch pills, lists, department view, date navigation; and sign-in with TOTP, redirect, service worker activation, a push delivered
through the browser's push pipeline shown as a notification, unreadable payload, inbox, mark read, session restore after reload,
sign-out). **Not verified:** a real subscription through Google / Mozilla / Apple push services (the sandbox cannot reach them),
and installed-PWA behaviour on iOS.
