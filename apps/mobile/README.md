# apps/mobile — Timekeeper Work mobile app (Expo / React Native)

**Who uses it:** every employee records their own attendance here, **including the Org Admin, HR and Managers** (their staff account is
linked to their own employee record, `PUT /v1/users/:id/employee`). The app has only employee functions for every role (register the
phone, health check, today, own history); management tools stay in the web app. Staff sign in with the same two-step login as on the web.

## Status

First slice written (Expo SDK 57, TypeScript). **Written and tested here:** the API client with token renewal, sign-in with the two-step code
and the forced password change, QR registration, the offline outbox and its uploader, the geofence plan, the health checks, the
"Миний ирц" month folders, the Mongolian texts. **Checked:** `tsc`, ESLint, 42 unit tests, the same client against the real API
(`test/contract.test.ts`) and a Metro/Hermes bundle (`pnpm --filter @timekeeper/mobile bundle`).

**Not verified, because it needs real phones (Phase 0, Spike 1):** that the geofence ENTER / EXIT events arrive in the background after 2 h
idle and after a reboot, on the target Android and iPhone models; battery use; OEM background restrictions. The screens were not
run on a device or an emulator.

## Run

```
pnpm install
cd apps/mobile
EXPO_PUBLIC_API_URL=http://<your computer>:3001 pnpm start     # Expo dev server (Expo Go is NOT enough: background geofencing needs a development build)
pnpm test                                                       # unit tests (Node)
```

A development build (`eas build --profile development` or `expo run:android` / `expo run:ios`) is needed for background location. The API
URL comes from `EXPO_PUBLIC_API_URL`, else `extra.apiUrl` in `app.json`.

The contract test talks to a real API and is skipped unless `TKW_E2E_URL`, `TKW_E2E_ORG`, `TKW_E2E_USER`, `TKW_E2E_PASSWORD`, `TKW_E2E_QR`
(a fresh onboarding QR token) and `TKW_E2E_LOCATION` are set.

## Building the installable app (Android APK / iPhone)

The project is a real React Native app: `expo prebuild` generates the native Android (Gradle) and iOS (Xcode) projects from `app.json`
(checked here for both platforms; permissions, background-location mode, camera text and the launcher icon come out as intended, and the
microphone permission is blocked). The generated `android/` and `ios/` folders are not committed (they are made from `app.json`).
Building the binary needs tools that are not in this repository's sandbox (the Android SDK, an Apple toolchain), so it is done in one of two ways:

**A. In the cloud with EAS (no Android Studio, no Mac)** — needs a free Expo account:

```
npm i -g eas-cli && eas login
cd apps/mobile
# set the real API address in eas.json (env.EXPO_PUBLIC_API_URL) for the profile you build
eas build --platform android --profile preview        # → an .apk link to install on a phone
eas build --platform ios --profile preview            # → needs an Apple Developer account (99 USD / year); registers the iPhone
eas build --platform all --profile production         # store builds (.aab / .ipa)
```

`development` makes a development client (for debugging with `pnpm start`), `preview` an installable test build, `production` the store build.

**B. On your computer** — Android Studio (SDK 35+) or Xcode (Mac): `pnpm --filter @timekeeper/mobile android` / `ios` (`expo run:android`).

Before the first real build: the API must be reachable from phones over **HTTPS** (not `localhost`); `app.json` has the package name
`mn.timekeeper.work`; Google Play needs a developer account (25 USD once), Apple an Apple Developer account. Spike 1 (real phones, background
location after 2 h idle and after a reboot) is done with the `preview` build on the target phone models.

## Structure

```
index.ts                     registers the root component; imports the geofence task first (the OS may start the app only to deliver an event)
src/
  lib/          api.ts (client: bearer, one shared refresh, problem+json) · errors · qr (tkw://register?token=)
  services/     outbox (queue in storage) · sync (batches, idempotent, offline-safe) · plan (regions from /v1/mobile/plan)
                health (checks) · geofence-capture (OS event → outbox event)
  features/     history/group.ts (month folders, weeks, totals)
  platform/     expo / react-native bindings: runtime (secure tokens, API client, outbox) · geofence (expo-location + task)
                health (permissions) · device (install key, model)
  screens/      Login · Password · Register (camera QR) · Today · History · Device (health, sign out)
  i18n/mn.ts    every text the employee sees, errors keyed by the API's stable `code`
```

## How it works

- **Sign-in:** `POST /auth/login` (organization code, username, password) → the authenticator code when the account has one (Org Admin, HR) →
  a new password when the account still has a temporary one. TOTP set-up is done once on the web, not in the app.
- **Registering the phone:** the HR QR (`tkw://register?token=…`) is scanned with the camera and sent to `POST /devices/register` with the
  model, OS and an install key. Errors (consent missing, QR expired, QR for someone else, a phone already registered) are shown in Mongolian.
- **The plan:** `GET /v1/mobile/plan` returns today and the next two days (hours and places, from the same `getExpectation` as the server).
  Only those places are registered as geofences (never every location of the organization, PRD 15.3); the list is refreshed on start,
  when the app returns to the front and every 30 minutes. Personal hours with several places register all of them.
- **Events:** the OS reports ENTER / EXIT → a quick high-accuracy fix is added when possible → the event goes into the **outbox**
  (`clientEventId` = UUID) → the uploader sends batches of 50. The age of the event is worked out when it is uploaded (the server
  computes the time as "now − age", PRD 6.8). Nothing is lost offline; a repeated upload is a harmless duplicate; a phone the server
  refuses (403) keeps its events and tells the person to contact HR.
- **Heartbeat:** `POST /v1/heartbeat` after each upload and when the app comes to the front (so the server knows the phone is alive).

## Not done yet

- **Spike 1:** the geofencing library decision on real phones. The code sits behind `GeofenceService` (`platform/geofence.ts`) so the
  library can be replaced (`react-native-background-geolocation` is the first alternative to evaluate).
- **Attestation:** Play Integrity / App Attest (Spike 2). The install key is a random value in the secure keystore; the server records
  such phones as UNVERIFIED. No device key pair in secure hardware yet.
- **The outbox** is in AsyncStorage (not encrypted SQLite as in Architecture 7.2); it holds only ids, times and coordinates of fixes.
- Background **heartbeat and upload when the app is closed** (only geofence events trigger an upload then); a periodic background task.
- Health: the battery-optimisation check is a manual confirmation (it cannot be read); notification permission and the "minimum app
  version" screen (`GET /app/config`, force-upgrade) are not built; OEM-specific instructions are not content-driven yet.
- TOTP set-up and recovery-code screens, "forgot password", push notifications to the phone.
- Release builds, store listings, crash reporting.
