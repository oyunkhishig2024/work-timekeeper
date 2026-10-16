# Admin web app (Next.js)

Used on a desktop or laptop by the **Org Admin, HR and Manager** (the Super Admin later). They record their own attendance on the phone app, not here (PRD 4).

Early build: sign-in, the dashboard (Хянах самбар), the daily attendance screen (Өдрийн ирц), the review lists (Хяналт), the employee register (Ажилтнууд) and the Org Admin notifications page.
Roster, reports, QR and settings screens are still to come (the clickable prototype shows the intended design).

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
- Today's numbers refresh every minute (the worker moves people from "not yet due" to "no show" when the day ends).
- Numbers come from `GET /v1/attendance/summary`, lists from `GET /v1/attendance/daily` (`status=EXPECTED` = the total). The web only
  formats; no attendance rule is repeated here.

## Daily attendance (`/daily`, PRD 9)

Same URL-state idea as the dashboard (`?date=&status=&location=&department=&q=`). Open to Org Admin, HR and Manager; only Org Admin and HR
get the actions and the export (a Manager's export depends on a tenant setting, so it is not offered in the UI).

- Chips with counts: **Бүгд** (everyone expected), Цагтаа, Хоцорсон, Шалтгаантай, Ирээгүй, **Байршил идэвхгүй** (PRD 6.5: expected, no
  arrival, phone silent for over an hour; shown with "last heard" time; a phone that never reported says so). Branch and department
  selects, a search box (name or code, debounced). Counts follow the other filters.
- Columns: employee (rank, position or code), department, primary branch, **expected branch with a «Түр» badge** when it differs,
  status (+ "Засварласан", "⚑ шалгах"), arrival time, **departure time** (with «Эрт гарсан · N мин» when more than the tolerance early; chip **Эрт гарсан**; the last exit; «Байгаа» while inside, «Тодорхойгүй» when the phone never reported leaving), minutes late, reason (+ its written explanation).
- **Шалтгаан**: assign a reason for the date, optionally until a later date. «Бусад» needs a written explanation. The day changes at once.
- **Засах**: correction (PRD 6.9): Цагтаа / Хоцорсон / Ирээгүй, optional arrival time typed in the organization's time zone
  (`src/lib/time.ts`), mandatory correction reason, note (required for «Бусад»); **Засварыг цуцлах** goes back to the system value.
- **Excel / CSV / PDF**: `GET /v1/exports/daily-attendance` with the same filters (token sent in the header, file saved from a blob).
- Today's list refreshes every minute.

- **Bulk reason assignment** (Org Admin / HR): tick employees in the first column (the header box ticks every row that can still get a
  reason). A strip under the title shows **Шалтгаан оноох (N)**, **Бүгдийг болиулах** and one chip per ticked employee with a × to remove
  them, so the selection stays visible whatever the filters or search show. The selection is kept as whole rows, belongs to one date, is
  cleared after saving and holds at most 500 people (the API limit). One call to `POST /v1/reason-assignments`, all or nothing; when
  someone already has a reason in the period (`REASON_OVERLAP`) the dialog names them so they can be unticked.

- **Ажлын цаг тогтоох** (same selection strip): fixes hours for the chosen employees over a range of dates (PRD 14.4), with one or more places (the first ticked is the main one). Overlaps are named; deleting is only in the API for now.

## Reports (`/reports`, PRD 20, 23.2)

Three lists: **Баяр, амралтын өдөр ажилласан** (a row per employee and date with the kind of day, the arrival and the departure; nothing is counted, HR decides), and **Дутуу цаг** and **Илүү цаг** per employee for a **7 хоног** (Monday to Sunday) or a **Сар** (calendar month), with ‹ Өмнөх / Энэ / Дараах › and the branch and department filters (`?type=&period=&date=&location=&department=`). The table shows days attended, late and left-early days with their time, the short time (late + left-early, ц:мм), no-show days, or the overtime days and time. Excel / CSV / PDF export the same report (`/v1/exports/short-hours`, `/v1/exports/overtime`).

Not here yet: ending or changing a reason from this screen (use the reason assignments API).

## Review (`/review`, `/device-alerts`; PRD 6.7)

Org Admin and HR (the menu entry **Хяналт**, two tabs with the number of open items).

- **Сэжигтэй event** (`/review`): events that were accepted and flagged (mock location, poor accuracy, clock skew, impossible speed, failed
  attestation, device conflict). Each card: person, enter/exit, branch, time (organization zone), every flag with a plain explanation,
  whether it counts towards attendance, accuracy, the phone's clock, a map link for the coordinates (opened only on click). Actions:
  **Баталгаажуулах** (clears the flag), **Няцаах** (reason required; the event stops counting and the day is rebuilt),
  **Дахин шалгахыг хүсэх** (once). Filters: Нээлттэй / Бүгд / Баталсан / Няцаасан, and per employee. A yellow box lists employees with
  3 or more flagged events in 7 days.
- **Төхөөрөмжийн сэрэмжлүүлэг** (`/device-alerts`): attestation silent for five batches, device conflict; **Шийдсэн болгох** with a note.
  These are the pages the push notifications link to.

## Employees (`/employees`, `/employees/:id`; PRD 12)

Open to Org Admin, HR and Manager (a Manager sees only their data scope, read-only); Org Admin and HR change things.

- **List**: code, name, rank, position, department, branch, consent, phone, status; filters Идэвхтэй / Идэвхгүй / Архивласан / Бүгд, department,
  branch, search by name or code (debounced); 50 per page; Excel / CSV / PDF export of the filtered list (`/v1/exports/employees`).
- **+ Ажилтан нэмэх**: Овог and Нэр as separate fields, rank and position as free text with suggestions from what the organization already uses,
  department, branch, start date, schedule mode, manual attendance. The **16-digit code is assigned by the system** and shown after saving.
- **Detail**: basic data (edit sends only what changed; an emptied rank or position removes it), **rank history and position history** each with
  its own "change" dialog (effective date and an order number note; dates are the organization's, not the browser's), login (create: the one-time
  password is shown once), **device history**, **Утас солих QR** (single-use replacement QR drawn in the browser with `qrcode`; shown once; an Org Admin
  may add a consent override reason), disable the phone (lost / stolen / other), consent state, and lifecycle: **disable** (effective date, reason),
  **reactivate** (department and branch re-confirmed, a new one-time password if there is a login), **archive**.
- **Excel-ээр оруулах** (`/employees/import`, PRD 12.3): template download, file check, **Шалгах (dry run)** with a per-row report (valid / warning / error, the diff for updates, Mongolian messages, only-problems filter), then **Оруулах**. Options: valid rows only or stop on any error, allow namesakes, create logins. After importing: a **result sheet with the new codes** (upload it later to update the same people) and, with logins, the **one-time passwords sheet** (shown once, the server keeps no copy). CSV sheets are formula-safe and open correctly in Excel.
- Not here yet: consent printing and "mark signed", temporary location assignments, the shared
  registration QR screen, scope settings.

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

## Branches and departments (`/locations`)

Org Admin also manages departments (Хэлтэс, нэгж) on the same page. Org Admin adds and edits the places where attendance is recorded (name, coordinates, radius 100–500 m, active flag). Coordinates can be pasted from Google Maps or taken from the browser's position.

## First sign-in (`/setup`)

An account created by the CLI or by an admin has a temporary password. After signing in the app sends it to `/setup`: replace the password, then (Org Admin and HR) scan the QR code with an authenticator app and confirm a code; the one-time recovery codes are shown once. `AppShell` redirects there while the session's `requires` list is not empty.

## Schedule (`/schedule`, «Цагийн хуваарь»)

Tab «Ажлын цаг, дүрэм»: the working week (7 days, times; organization-wide or one branch's own, with «use the default» for a branch) and the attendance rules (late tolerance, minimum stay, early-leave tolerance). A change is effective-dated and applies from the chosen date forward (default tomorrow; the past is never rewritten); a saved change that has not begun is shown as «Төлөвлөсөн өөрчлөлт». Tab «Баяр, онцгой өдөр»: holidays by year (add, edit, delete, copy the previous year; a holiday that starts today or earlier asks for confirmation because attendance is recomputed) and single-date exceptions (a working day, optionally with other hours, or a day off, for the organization or a branch; the next 180 days). Tab «Ээлж»: shift templates (start/end, grace, observes holidays; changing a used template makes a new version), rotation patterns (day-by-day template or day off) — Org Admin; assignments of a template or pattern to employees whose schedule mode is «Ээлжээр» — Org Admin and HR (a future assignment can be deleted, a running one is ended today). One-day shift overrides (ADD/REMOVE/SWAP) are API-only for now. Only the Org Admin changes the working week, rules, holidays and shift setup; HR and Manager read.

## Phone layout and accessibility conventions

Checked at 375 px with Playwright (no page scrolls sideways; wide tables scroll inside their own box) and by keyboard.

- The menu wraps (`flex-wrap`); dialogs are at most the screen height (`max-h-[calc(100dvh-2rem)]`, scroll inside).
- Every route has a `layout.tsx` with `metadata.title` (pages are client components and cannot export metadata themselves); the root layout adds « · Timekeeper Work». Nested routes write the full title.
- The first Tab stop is the «Үндсэн агуулга руу очих» skip link (`#main` in `AppShell`); one focus ring for everything (`globals.css`).
- Errors use `<FormError>` (`components/form-error.tsx`): `role="alert"` and scrolls into view. A field-level error also marks the field `aria-invalid`, links it with `aria-describedby` and focuses it (see `employee-form.tsx` and `employeeFormIssue` in `lib/employees.ts`); do the same when you add a form.
- Interactive elements are at least 44 px tall (`min-h-11`).

## Super Admin pages

`/platform/login`, `/platform/setup` and `/platform` (organizations, activity) are for the platform owner only. They use their own client `src/lib/platform.ts` (own token and storage key, no refresh), not the staff session. See `apps/api/src/platform/README.md`.

## Security headers

Every page (not `/v1`) gets a Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` and a
Permissions-Policy from `security-headers.ts` (tested in `test/security-headers.test.ts`); `X-Powered-By` is off. HSTS is sent
by Caddy (`infra/deploy/Caddyfile`). Scripts keep `'unsafe-inline'` because Next.js needs inline scripts to start a page; when
adding anything that loads from another site (a map, analytics, fonts), add its address to the policy on purpose, never `*`.
