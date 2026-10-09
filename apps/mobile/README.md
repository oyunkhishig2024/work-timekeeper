# apps/mobile — Timekeeper Work mobile app (React Native)

**Not scaffolded yet — intentionally.** The choice of project template (Expo development build vs.
bare React Native) depends on the geofencing library chosen in **Phase 0, Spike 1**
(`docs/Timekeeper_Work_Architecture.md` Sections 7.3 and 14): candidates are
`react-native-background-geolocation` (Transistorsoft, commercial licence for Android release
builds) and `expo-location`. Scaffolding first would risk rework.

**Who uses it:** every employee records their own attendance here, **including the Org Admin, HR and Managers** (their staff account is linked to their own employee record, `PUT /v1/users/:id/employee`). The app has only employee functions for every role (register the phone, health check, today, own history); management tools stay in the web app. Staff sign in with the same two-step login as on the web.

Planned structure once scaffolded (Architecture Section 7.2):

```
src/
  features/   auth · onboarding (QR + consent gate) · health · history
  services/   GeofenceService · LocationVerifier · AttestationService · Outbox · SyncService · HeartbeatService
  native/     platform bridges (App Attest, Play Integrity, geofence library adapter)
```

Rules:

- Geofencing code sits behind our own `GeofenceService` interface so the library can be replaced.
- Events carry a client-generated `client_event_id`, device time and a monotonic offset (PRD 6.8).
- Shared types and rules come from `@timekeeper/domain`; the API client is generated from the API's
  OpenAPI document.
- This folder is excluded from the root ESLint config until the app is scaffolded.
