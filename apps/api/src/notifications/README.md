# Notifications (Org Admin)

Alerts reach the Org Admin in two ways: an in-app **inbox** (always) and **Web Push** to subscribed browsers (when configured).

## What is announced

| Event                                                               | Kind                       | Link                              |
| ------------------------------------------------------------------- | -------------------------- | --------------------------------- |
| Device alert: five unavailable attestation verdicts in a row (6.7)  | `DEVICE_ALERT_ATTESTATION` | `/device-alerts`                  |
| Device alert: DEVICE_CONFLICT (6.7)                                 | `DEVICE_ALERT_CONFLICT`    | `/device-alerts`                  |
| Someone left early (23.2), once per day, no names                   | `EARLY_LEAVE`              | `/daily?date=&status=EARLY_LEAVE` |
| One user made more than 10 corrections in a day (6.9), once per day | `CORRECTION_VOLUME`        | `/corrections/report`             |
| Test button                                                         | `TEST`                     | -                                 |

Every active user with role `ORG_ADMIN` of the tenant receives it (HR and Manager do not). The notification row is written in
the **same transaction** as the alert (`notifyOrgAdmins`, `enqueue.ts`), so it cannot be lost or describe a rolled-back change.
One event is announced to a user once (`dedupe_key`).

**The text is generic on purpose** (no names, codes, places or times): it travels through the browser vendor's push service
(Google, Mozilla, Apple, Microsoft). The details are in the admin app after sign-in (PRD 15.3).

## Delivery

The worker (`NotificationTicker`, every 15 s) pushes due rows in every tenant (`NotificationsService.dispatchTenant`):

- push not configured, or the admin has no subscribed browser → `SKIPPED` (the inbox is the delivery);
- sent to at least one subscription → `SENT`; a subscription answering 404/410 is switched off;
- otherwise retried after 1, 5, 30 and 120 minutes (`push_attempts`, `next_attempt_at`), then `FAILED`. The inbox keeps it either way.

## Setup

1. `npx web-push generate-vapid-keys`, set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:` or https) for the API **and** the worker.
2. The admin web app (not built yet) gets the public key from `GET /v1/push/config`, registers a service worker, calls
   `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` and sends the result to `POST /v1/push/subscriptions`.
3. Check with `POST /v1/push/test` (queues a test message for the caller only).

## API (ORG_ADMIN only)

| Endpoint                                       | Purpose                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /v1/push/config`                          | `{ enabled, publicKey }`                                                      |
| `POST /v1/push/subscriptions {endpoint, keys}` | register this browser (a browser that signs in as someone else takes it over) |
| `DELETE /v1/push/subscriptions {endpoint}`     | unsubscribe                                                                   |
| `POST /v1/push/test`                           | test message to the caller                                                    |
| `GET /v1/notifications?unread=&limit=&offset=` | own inbox, with `unread` count                                                |
| `POST /v1/notifications/:id/read`, `/read-all` | mark read                                                                     |

## Security

The server posts to the subscription's URL, so `endpoint` must be `https` on a known push service
(`PUSH_ENDPOINT_HOSTS`, default FCM, Mozilla, Apple, Windows); anything else is `400 PUSH_ENDPOINT_NOT_ALLOWED` (no way to
reach internal addresses through the API). Messages are encrypted end to end to the browser (RFC 8291) by the `web-push` library.

## Not built / not verified

Delivery was tested against a stand-in sender, **not against a real push service** (needs real VAPID keys and a browser).
Native mobile push (FCM / APNs) for a mobile Org Admin app, per-user notification preferences, quiet hours, and notifying HR.
