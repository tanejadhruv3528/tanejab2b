-- Cart, configurable pricing rules and price quotes.

CREATE TABLE carts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_account_id uuid NOT NULL UNIQUE REFERENCES retailer_accounts (id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cart_items (
  cart_id    uuid NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products (id),
  quantity   integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, product_id)
);

-- Order-value discount slabs. Rules are created as drafts; they only apply when active AND the
-- pricing.discounts_enabled setting is true, which must wait for the owner to confirm the rates.
CREATE TABLE pricing_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN ('order_value_slab')),
  min_subtotal_paise bigint NOT NULL CHECK (min_subtotal_paise >= 0),
  discount_bps       integer NOT NULL CHECK (discount_bps BETWEEN 0 AND 5000),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  note               text,
  created_by         uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX pricing_rules_active_slab_idx
  ON pricing_rules (min_subtotal_paise) WHERE status = 'active' AND kind = 'order_value_slab';

-- Immutable snapshot of a priced cart. Orders will reference a quote so the price a retailer saw is the price charged.
CREATE TABLE price_quotes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_account_id uuid NOT NULL REFERENCES retailer_accounts (id),
  snapshot            jsonb NOT NULL,
  payable_paise       bigint NOT NULL,
  can_checkout        boolean NOT NULL,
  expires_at          timestamptz NOT NULL,
  used_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX price_quotes_account_idx ON price_quotes (retailer_account_id, created_at DESC);

INSERT INTO app_settings (key, value, description) VALUES
  ('pricing.rates_include_gst', 'false',
   'Whether batch rates already include GST. Assumed false (GST added on top) until confirmed against Marg invoices.'),
  ('catalog.cold_chain_enabled', 'false',
   'Cold-chain products cannot be ordered until handling and delivery controls are validated.'),
  ('cod.service_zones', '[]',
   'Service zones where COD is allowed. Empty means any store with an assigned service zone.'),
  ('pricing.quote_ttl_minutes', '15', 'How long a price quote stays valid for checkout.');
