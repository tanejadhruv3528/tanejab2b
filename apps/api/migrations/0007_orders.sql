-- Orders placed from price quotes, with separate fulfilment and payment statuses.

CREATE SEQUENCE order_number_seq START 1001;

CREATE TABLE orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number        text NOT NULL UNIQUE DEFAULT ('TDA-' || nextval('order_number_seq')),
  retailer_account_id uuid NOT NULL REFERENCES retailer_accounts (id),
  placed_by           uuid NOT NULL REFERENCES users (id),
  quote_id            uuid NOT NULL UNIQUE REFERENCES price_quotes (id),
  idempotency_key     text NOT NULL,
  status              text NOT NULL DEFAULT 'placed' CHECK (status IN
                        ('placed', 'accepted', 'picking', 'short_pick_review', 'packed', 'ready_for_dispatch',
                         'assigned_to_rider', 'out_for_delivery', 'delivered', 'cancel_requested', 'cancelled',
                         'delivery_failed', 'returned', 'closed')),
  payment_method      text NOT NULL CHECK (payment_method IN ('prepaid', 'cod')),
  payment_status      text NOT NULL CHECK (payment_status IN
                        ('awaiting_payment', 'paid', 'payment_failed', 'cod_due', 'cod_collected',
                         'refund_pending', 'not_charged')),
  subtotal_paise      bigint NOT NULL CHECK (subtotal_paise >= 0),
  discount_paise      bigint NOT NULL CHECK (discount_paise >= 0),
  tax_paise           bigint NOT NULL CHECK (tax_paise >= 0),
  delivery_fee_paise  bigint NOT NULL CHECK (delivery_fee_paise >= 0),
  payable_paise       bigint NOT NULL CHECK (payable_paise >= 0),
  -- Where to deliver, frozen at order time from the verified store location.
  delivery_address    jsonb NOT NULL,
  payment_due_by      timestamptz,
  placed_at           timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (retailer_account_id, idempotency_key)
);

CREATE INDEX orders_account_idx ON orders (retailer_account_id, placed_at DESC);
CREATE INDEX orders_status_idx ON orders (status, placed_at);
CREATE INDEX orders_unpaid_idx ON orders (payment_due_by) WHERE payment_status = 'awaiting_payment';

-- Immutable price snapshot per line.
CREATE TABLE order_items (
  order_id       uuid NOT NULL REFERENCES orders (id),
  product_id     uuid NOT NULL REFERENCES products (id),
  sku            text NOT NULL,
  name           text NOT NULL,
  pack_size      text,
  quantity       integer NOT NULL CHECK (quantity > 0),
  value_paise    bigint NOT NULL,
  discount_paise bigint NOT NULL,
  taxable_paise  bigint NOT NULL,
  gst_rate_bps   integer NOT NULL,
  tax_paise      bigint NOT NULL,
  total_paise    bigint NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

-- Which batches are reserved for the order; released on cancellation.
CREATE TABLE order_allocations (
  order_id    uuid NOT NULL REFERENCES orders (id),
  product_id  uuid NOT NULL REFERENCES products (id),
  batch_id    uuid NOT NULL REFERENCES inventory_batches (id),
  quantity    integer NOT NULL CHECK (quantity > 0),
  released_at timestamptz,
  PRIMARY KEY (order_id, batch_id)
);

CREATE TABLE order_events (
  id            bigserial PRIMARY KEY,
  order_id      uuid NOT NULL REFERENCES orders (id),
  kind          text NOT NULL CHECK (kind IN ('status', 'payment')),
  from_value    text,
  to_value      text NOT NULL,
  actor_user_id uuid REFERENCES users (id),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_events_order_idx ON order_events (order_id, id);

CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders (id),
  provider     text NOT NULL,
  provider_ref text NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  status       text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'succeeded', 'failed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);

CREATE INDEX payments_order_idx ON payments (order_id);

-- Every verified webhook is recorded once; replays are acknowledged without being applied again.
CREATE TABLE payment_webhook_events (
  provider    text NOT NULL,
  event_id    text NOT NULL,
  payment_id  uuid REFERENCES payments (id),
  outcome     text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

INSERT INTO app_settings (key, value, description) VALUES
  ('payments.prepaid_window_minutes', '30',
   'Unpaid prepaid orders are cancelled and their stock released after this many minutes.');
