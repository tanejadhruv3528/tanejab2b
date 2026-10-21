-- Delivery: rider assignments, OTP proof of delivery, failed attempts and COD collection/reconciliation.

CREATE TABLE delivery_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders (id),
  rider_user_id   uuid NOT NULL REFERENCES users (id),
  assigned_by     uuid NOT NULL REFERENCES users (id),
  status          text NOT NULL DEFAULT 'assigned' CHECK (status IN
                    ('assigned', 'out_for_delivery', 'delivered', 'failed', 'cancelled')),
  -- HMAC of the code sent to the retailer by SMS; the code itself is never stored.
  otp_hash        text,
  otp_sent_count  integer NOT NULL DEFAULT 0,
  otp_attempts    integer NOT NULL DEFAULT 0,
  otp_expires_at  timestamptz,
  failure_reason  text CHECK (failure_reason IS NULL OR failure_reason IN
                    ('store_closed', 'retailer_refused', 'address_issue', 'payment_not_ready', 'otp_unavailable', 'other')),
  failure_note    text,
  cancel_reason   text,
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  delivered_at    timestamptz,
  failed_at       timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- At most one live assignment per order.
CREATE UNIQUE INDEX delivery_assignments_live_idx ON delivery_assignments (order_id)
  WHERE status IN ('assigned', 'out_for_delivery');
CREATE INDEX delivery_assignments_rider_idx ON delivery_assignments (rider_user_id, status);

-- Cash or UPI taken by the rider for a COD order, and finance's check of what was handed over.
CREATE TABLE cod_collections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             uuid NOT NULL UNIQUE REFERENCES orders (id),
  assignment_id        uuid NOT NULL REFERENCES delivery_assignments (id),
  rider_user_id        uuid NOT NULL REFERENCES users (id),
  method               text NOT NULL CHECK (method IN ('cash', 'upi')),
  expected_paise       bigint NOT NULL CHECK (expected_paise > 0),
  collected_paise      bigint NOT NULL CHECK (collected_paise >= 0),
  -- UPI reference read off the retailer's payment screen; it is not verified with any bank.
  upi_reference        text,
  collected_at         timestamptz NOT NULL DEFAULT now(),
  status               text NOT NULL DEFAULT 'collected' CHECK (status IN ('collected', 'reconciled', 'discrepancy')),
  handed_over_paise    bigint CHECK (handed_over_paise IS NULL OR handed_over_paise >= 0),
  reconciled_by        uuid REFERENCES users (id),
  reconciled_at        timestamptz,
  reconcile_note       text
);

CREATE INDEX cod_collections_status_idx ON cod_collections (status, collected_at);

-- The delivery hours setting (delivery.window) already exists from 0001_foundation.
