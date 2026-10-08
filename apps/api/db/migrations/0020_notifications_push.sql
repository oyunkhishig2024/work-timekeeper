-- Up Migration
-- Notifications for the Org Admin: an in-app inbox plus Web Push delivery through a transactional outbox.
-- A notification is written in the same transaction as the thing it announces (a device alert, a correction alert), so
-- it cannot be lost or sent for a rolled-back change; the worker pushes it afterwards and retries on failure.

CREATE TABLE push_subscription (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant (id),
  user_id           uuid NOT NULL,
  -- Web Push (RFC 8030 / 8291 / 8292): the browser's push service URL and its keys.
  endpoint          text NOT NULL CHECK (char_length(endpoint) <= 2048),
  p256dh            text NOT NULL,
  auth              text NOT NULL,
  user_agent        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_success_at   timestamptz,
  -- Set when the push service says the subscription is gone (404 / 410) or the user unsubscribed.
  disabled_at       timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, endpoint),
  FOREIGN KEY (tenant_id, user_id) REFERENCES user_account (tenant_id, id)
);
CREATE INDEX push_subscription_user_idx ON push_subscription (tenant_id, user_id) WHERE disabled_at IS NULL;
SELECT apply_tenant_rls('push_subscription');

CREATE TABLE notification (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant (id),
  user_id          uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN
                     ('DEVICE_ALERT_ATTESTATION', 'DEVICE_ALERT_CONFLICT', 'CORRECTION_VOLUME', 'TEST')),
  -- Deliberately generic (no names or places): the text travels through the browser vendor's push service.
  title            text NOT NULL,
  body             text NOT NULL,
  -- Where the admin app opens it, relative to the app root.
  link             text,
  -- The same event is announced to a user once.
  dedupe_key       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  read_at          timestamptz,
  push_state       text NOT NULL DEFAULT 'PENDING' CHECK (push_state IN ('PENDING', 'SENT', 'SKIPPED', 'FAILED')),
  push_attempts    integer NOT NULL DEFAULT 0,
  -- NULL = due now; set to a later time after a failed attempt.
  next_attempt_at  timestamptz,
  push_sent_at     timestamptz,
  push_error       text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id, dedupe_key),
  FOREIGN KEY (tenant_id, user_id) REFERENCES user_account (tenant_id, id)
);
CREATE INDEX notification_inbox_idx ON notification (tenant_id, user_id, created_at DESC);
CREATE INDEX notification_due_idx ON notification (created_at) WHERE push_state = 'PENDING';
SELECT apply_tenant_rls('notification');

-- Down Migration
DROP TABLE notification;
DROP TABLE push_subscription;
