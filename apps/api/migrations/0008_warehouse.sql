-- Warehouse: pick lists per accepted order, short-pick exceptions, pack checks and the Marg invoice record.

-- One pick task per order, created when staff accept it.
CREATE TABLE warehouse_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL UNIQUE REFERENCES orders (id),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN
                    ('open', 'picking', 'short_pick', 'picked', 'packed', 'cancelled')),
  assigned_to     uuid REFERENCES users (id),
  started_at      timestamptz,
  picked_at       timestamptz,
  packed_by       uuid REFERENCES users (id),
  packed_at       timestamptz,
  package_count   integer CHECK (package_count IS NULL OR package_count BETWEEN 1 AND 50),
  pack_checklist  jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX warehouse_tasks_status_idx ON warehouse_tasks (status, created_at);

-- What to take from which batch. A short pick keeps its line; re-allocation adds new lines.
CREATE TABLE warehouse_pick_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES warehouse_tasks (id),
  product_id    uuid NOT NULL REFERENCES products (id),
  batch_id      uuid NOT NULL REFERENCES inventory_batches (id),
  expected_qty  integer NOT NULL CHECK (expected_qty > 0),
  picked_qty    integer CHECK (picked_qty IS NULL OR picked_qty BETWEEN 0 AND expected_qty),
  short_reason  text CHECK (short_reason IS NULL OR short_reason IN ('not_found', 'damaged', 'expiry_mismatch', 'other')),
  short_note    text,
  -- Set once staff have dealt with the shortfall (re-allocated from another batch).
  short_resolved_at timestamptz,
  confirmed_by  uuid REFERENCES users (id),
  confirmed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((picked_qty IS NULL) = (confirmed_at IS NULL)),
  CHECK (picked_qty IS NULL OR picked_qty = expected_qty OR short_reason IS NOT NULL)
);

CREATE INDEX warehouse_pick_lines_task_idx ON warehouse_pick_lines (task_id, created_at);

-- The tax invoice raised in Marg for a packed order, entered by billing staff.
CREATE TABLE order_invoices (
  order_id          uuid PRIMARY KEY REFERENCES orders (id),
  invoice_number    text NOT NULL UNIQUE,
  amount_paise      bigint NOT NULL CHECK (amount_paise > 0),
  -- Set when the invoice total differs from the order's payable amount and staff accepted it anyway.
  mismatch_reason   text,
  source            text NOT NULL DEFAULT 'marg_manual_entry' CHECK (source IN ('marg_manual_entry')),
  recorded_by       uuid NOT NULL REFERENCES users (id),
  recorded_at       timestamptz NOT NULL DEFAULT now()
);

-- Invoiced stock leaves the warehouse: reserved and on-hand units both go down.
ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_kind_check;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_kind_check
  CHECK (kind IN ('sync', 'reserve', 'release', 'quarantine', 'unquarantine', 'adjust', 'invoice'));
