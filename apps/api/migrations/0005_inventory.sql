-- Inventory: stock by batch at the Taneja warehouse, plus stock import history.

CREATE TABLE inventory_sync_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text NOT NULL CHECK (source IN ('marg_export', 'manual_count')),
  filename      text,
  uploaded_by   uuid NOT NULL REFERENCES users (id),
  -- When the source system produced the data (e.g. Marg export time), not when it was uploaded.
  as_of         timestamptz NOT NULL,
  dry_run       boolean NOT NULL,
  status        text NOT NULL CHECK (status IN ('validated', 'applied', 'rejected')),
  total_rows    integer NOT NULL,
  applied_rows  integer NOT NULL DEFAULT 0,
  unknown_skus  text[] NOT NULL DEFAULT '{}',
  oversold      jsonb NOT NULL DEFAULT '[]',
  errors        jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       uuid NOT NULL REFERENCES products (id),
  batch_number     text NOT NULL,
  expiry_date      date NOT NULL,
  mrp_paise        bigint CHECK (mrp_paise IS NULL OR mrp_paise > 0),
  -- Taneja's selling rate to retailers. Supplier purchase costs are never stored here.
  rate_paise       bigint CHECK (rate_paise IS NULL OR rate_paise > 0),
  on_hand_qty      integer NOT NULL DEFAULT 0 CHECK (on_hand_qty >= 0),
  reserved_qty     integer NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  quarantined_qty  integer NOT NULL DEFAULT 0 CHECK (quarantined_qty >= 0),
  location         text,
  synced_at        timestamptz,
  last_sync_run_id uuid REFERENCES inventory_sync_runs (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, batch_number)
);

CREATE INDEX inventory_batches_fefo_idx ON inventory_batches (product_id, expiry_date);

-- Every stock movement, so reservations and adjustments can be reconstructed.
CREATE TABLE inventory_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id    uuid NOT NULL REFERENCES inventory_batches (id),
  kind        text NOT NULL CHECK (kind IN ('sync', 'reserve', 'release', 'quarantine', 'unquarantine', 'adjust')),
  quantity    integer NOT NULL,
  reference   text,
  actor_user_id uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inventory_movements_batch_idx ON inventory_movements (batch_id, created_at);

INSERT INTO app_settings (key, value, description) VALUES
  ('inventory.availability',
   '{"lowStockUnits": 10, "minShelfLifeDays": 30, "staleAfterMinutes": 240}',
   'Low-stock threshold, minimum remaining shelf life to sell a batch, and when stock data counts as stale.');
