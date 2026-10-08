# Admin web app (Next.js)

Early skeleton: sign-in and the Org Admin notifications page. The dashboard and the rest of the admin screens are still to come
(the clickable prototype shows the intended design).

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

`pnpm --filter @timekeeper/web test`: pure helpers (`push.ts`) and the service worker, which runs in a fake worker scope
(`test/sw.test.ts`: payloads, link safety, click handling, lifecycle).

Checked by hand in headless Chromium against a real API (sign-in with TOTP, redirect, service worker activation, a push delivered
through the browser's push pipeline shown as a notification, unreadable payload, inbox, mark read, session restore after reload,
sign-out). **Not verified:** a real subscription through Google / Mozilla / Apple push services (the sandbox cannot reach them),
and installed-PWA behaviour on iOS.
