-- Returns (goods return): retailer request with photo evidence, staff review, pickup, warehouse
-- inspection with disposition, the Marg GR reference and the outcome. No automatic refunds.

CREATE SEQUENCE return_number_seq START 1001;

CREATE TABLE return_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number         text NOT NULL UNIQUE DEFAULT ('RT-' || nextval('return_number_seq')),
  order_id              uuid NOT NULL REFERENCES orders (id),
  retailer_account_id   uuid NOT NULL REFERENCES retailer_accounts (id),
  requested_by          uuid NOT NULL REFERENCES users (id),
  note                  text,
  status                text NOT NULL DEFAULT 'requested' CHECK (status IN
                          ('requested', 'approved', 'rejected', 'cancelled', 'pickup_scheduled', 'received', 'closed')),
  decided_by            uuid REFERENCES users (id),
  decided_at            timestamptz,
  decision_reason       text,
  pickup_rider_user_id  uuid REFERENCES users (id),
  pickup_date           date,
  received_by           uuid REFERENCES users (id),
  received_at           timestamptz,
  -- Goods-return number from Marg, typed in by staff.
  gr_reference          text,
  resolution            text CHECK (resolution IS NULL OR resolution IN ('credit_note', 'replacement', 'no_action')),
  resolution_reference  text,
  closed_by             uuid REFERENCES users (id),
  closed_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX return_requests_account_idx ON return_requests (retailer_account_id, created_at DESC);
CREATE INDEX return_requests_status_idx ON return_requests (status, created_at);

CREATE TABLE return_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id       uuid NOT NULL REFERENCES return_requests (id),
  product_id      uuid NOT NULL REFERENCES products (id),
  quantity        integer NOT NULL CHECK (quantity > 0),
  reason          text NOT NULL CHECK (reason IN ('damaged', 'expired', 'near_expiry', 'wrong_item', 'excess_supply', 'other')),
  batch_number    text,
  -- Filled in at inspection.
  accepted_qty    integer CHECK (accepted_qty IS NULL OR accepted_qty BETWEEN 0 AND quantity),
  disposition     text CHECK (disposition IS NULL OR disposition IN ('restock', 'return_to_supplier', 'destroy')),
  restock_batch_id uuid REFERENCES inventory_batches (id),
  inspection_note text,
  UNIQUE (return_id, product_id)
);

CREATE TABLE return_evidence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id       uuid NOT NULL REFERENCES return_requests (id),
  storage_key     text NOT NULL,
  content_type    text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes      integer NOT NULL CHECK (size_bytes > 0),
  sha256          text NOT NULL,
  uploaded_by     uuid NOT NULL REFERENCES users (id),
  uploaded_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX return_evidence_return_idx ON return_evidence (return_id);

ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_kind_check;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_kind_check
  CHECK (kind IN ('sync', 'reserve', 'release', 'quarantine', 'unquarantine', 'adjust', 'invoice', 'receipt', 'return'));

INSERT INTO app_settings (key, value, description) VALUES
  ('returns.window_days', '7',
   'Days after delivery a retailer may request a return. Proposal only; the return policy is not yet approved.');
