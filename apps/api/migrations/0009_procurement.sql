-- Procurement: suppliers, special-order and restock requests, purchase orders and goods receipt at the Taneja warehouse.
-- Supplier details and purchase costs are internal and never reach retailer endpoints.

CREATE TABLE suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  gstin       text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  phone       text,
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE procurement_request_seq START 1001;

-- A retailer's special-order request or a staff restock request.
CREATE TABLE procurement_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number       text NOT NULL UNIQUE DEFAULT ('SR-' || nextval('procurement_request_seq')),
  kind                 text NOT NULL CHECK (kind IN ('special_order', 'restock')),
  retailer_account_id  uuid REFERENCES retailer_accounts (id),
  requested_by         uuid NOT NULL REFERENCES users (id),
  -- A catalogue product, or a name typed by the retailer that procurement links to a product later.
  product_id           uuid REFERENCES products (id),
  requested_name       text,
  quantity             integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  note                 text,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN
                         ('open', 'ordered', 'received', 'unavailable', 'cancelled')),
  -- ETA stays "to be confirmed" until procurement records a supplier-confirmed date.
  eta_date             date,
  eta_confirmed_at     timestamptz,
  outcome_note         text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (product_id IS NOT NULL OR requested_name IS NOT NULL),
  CHECK ((kind = 'special_order') = (retailer_account_id IS NOT NULL)),
  CHECK ((eta_date IS NULL) = (eta_confirmed_at IS NULL))
);

CREATE INDEX procurement_requests_status_idx ON procurement_requests (status, created_at);
CREATE INDEX procurement_requests_account_idx ON procurement_requests (retailer_account_id, created_at DESC);

CREATE SEQUENCE purchase_order_seq START 1001;

CREATE TABLE purchase_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number   text NOT NULL UNIQUE DEFAULT ('PO-' || nextval('purchase_order_seq')),
  supplier_id uuid NOT NULL REFERENCES suppliers (id),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN
                ('draft', 'sent', 'partially_received', 'received', 'cancelled')),
  note        text,
  created_by  uuid NOT NULL REFERENCES users (id),
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_order_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id       uuid NOT NULL REFERENCES purchase_orders (id),
  product_id              uuid NOT NULL REFERENCES products (id),
  procurement_request_id  uuid REFERENCES procurement_requests (id),
  quantity                integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  -- Internal purchase cost per unit, as quoted by the supplier. Never shown to retailers.
  unit_cost_paise         bigint NOT NULL CHECK (unit_cost_paise > 0),
  received_qty            integer NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  rejected_qty            integer NOT NULL DEFAULT 0 CHECK (rejected_qty >= 0),
  CHECK (received_qty + rejected_qty <= quantity)
);

CREATE INDEX purchase_order_items_po_idx ON purchase_order_items (purchase_order_id);

-- Each delivery checked in at the warehouse, by batch.
CREATE TABLE goods_receipts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_item_id  uuid NOT NULL REFERENCES purchase_order_items (id),
  batch_id                uuid REFERENCES inventory_batches (id),
  batch_number            text NOT NULL,
  expiry_date             date NOT NULL,
  accepted_qty            integer NOT NULL CHECK (accepted_qty >= 0),
  rejected_qty            integer NOT NULL CHECK (rejected_qty >= 0),
  reject_reason           text CHECK (reject_reason IS NULL OR reject_reason IN
                            ('damaged', 'short_expiry', 'wrong_item', 'other')),
  supplier_invoice_ref    text,
  received_by             uuid NOT NULL REFERENCES users (id),
  received_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (accepted_qty + rejected_qty > 0),
  CHECK (rejected_qty = 0 OR reject_reason IS NOT NULL)
);

CREATE INDEX goods_receipts_item_idx ON goods_receipts (purchase_order_item_id);

ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_kind_check;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_kind_check
  CHECK (kind IN ('sync', 'reserve', 'release', 'quarantine', 'unquarantine', 'adjust', 'invoice', 'receipt'));
