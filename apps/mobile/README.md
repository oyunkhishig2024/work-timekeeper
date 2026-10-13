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

## On-phone log

The «Утас» tab ends with «Сүүлийн үйлдлүүд»: the last 80 lines of what the app did (app start and open, plan loaded and how many places are watched, geofence ENTER/EXIT reported by the phone and the upload result, device rejoin, session ended, sign-out). Written by `DiagLog` (`src/services/diag.ts`), also from the background geofence task; no coordinates or names. Signing out asks for confirmation.

## Position watching (fallback for phones whose geofencing never reports)

On a pilot test two Xiaomi/Redmi phones never delivered a single system geofence ENTER/EXIT. So while a place is in the plan the app also asks for ordinary position fixes in the background (task `tkw-location`, `startLocationUpdatesAsync`, Balanced accuracy, every 30 s or 25 m, with a visible foreground-service notification «Ирцийн бүртгэл ажиллаж байна»; needs `isAndroidForegroundServiceEnabled`). `src/services/presence.ts` (pure, tested) turns the fixes into events: first trustworthy fix inside a place → ENTER (also when the app is first opened inside), EXIT only after two fixes in a row beyond radius + margin, fixes with accuracy over 150 m ignored. System geofence reports and fixes share one persisted state (`presence.v1`), so an ENTER/EXIT is sent once. Only events go to the server; positions stay on the phone (coordinates of the last fix go with an event as evidence, as before). It costs more battery than geofencing: measure it in the pilot. **The consent text must say that the phone checks its position while an expected place is watched.**

**Crash found on a real phone:** without the `RECEIVE_BOOT_COMPLETED` permission `expo-task-manager` throws «requested job be persisted without holding RECEIVE_BOOT_COMPLETED permission» when a background location or geofence event arrives, and the app stops (`app.json` now declares it). Always read the phone's crash report (Settings → feedback / «keeps stopping») when background events do not arrive.

**Xiaomi / Redmi / POCO (MIUI):** the permission `RECEIVE_BOOT_COMPLETED` follows the phone's «Autostart» switch (Settings → Apps → Permissions → Autostart). With it off the crash above happens even though the app declares the permission, and the app cannot catch it (native code). The phone check therefore has an «Autostart» item for these makers, confirmed by hand; setup instructions for staff must include it, together with battery «No restrictions» and locking the app in recents.

**Pilot findings (two walks, build h/i):** with Balanced accuracy the fixes were ±75–100 m, so the server flagged events LOW_ACCURACY (> 50 m), and a coarse fix near the edge produced a false ENTER 95 s after an EXIT; two tasks running at once reported the same ENTER twice. Now: High accuracy (GPS) every 60 s while a place is watched; coming back after a departure needs two fixes in a row inside unless one is exact (≤ 30 m); the geofence and position tasks run one after the other (`inOrder`). Measure battery in the pilot.

**Build k (2026-10-13):** GPS fix interval is now **5 minutes** (`POSITION_INTERVAL_MS`, was 60 s; 15 min was tried and rejected as too slow for departures; 5 min chosen by the owner) to save battery: first pilot measure was about 4.5 %/h with 60 s fixes. Cost: a departure needs two fixes outside in a row, so it is confirmed about 5–10 minutes after leaving unless the system geofence reports it sooner. When the GPS foreground service cannot be started (Android refuses it while the app is in the background, seen at 07:18 and 10:47), the app remembers it (`presence.watchFailed`) and starts it again the next time it is on screen. Pilot walk 2 (new place, 240+ m away): arrival, late upload with the real time, departure and «Эрт гарсан» all correct.

**Build l (2026-10-13) — MIUI crash fix:** on a Redmi Note 8 (MIUI 12.5, Android 11) the app crashed on every background location or geofence delivery with `IllegalArgumentException: requested job be persisted without holding RECEIVE_BOOT_COMPLETED permission` (trace: `LocationTaskConsumer.reportLocationsImmediately` → `TaskManagerUtils.scheduleJob` → `JobScheduler.schedule`), also with Autostart switched on. expo-task-manager always schedules a _persisted_ job. `patches/expo-task-manager@57.0.21.patch` (pnpm `patchedDependencies`) catches that refusal and schedules a job that is not persisted (it only misses a restart of the phone). Remove the patch when upgrading expo-task-manager and check the new `TaskManagerUtils` first. The server image is unaffected (`apps/mobile` is not installed there).
