-- Product catalogue: manufacturers, products, search aliases and import history.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE manufacturers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX manufacturers_name_idx ON manufacturers (lower(name));

CREATE TABLE catalog_import_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Where the data came from (e.g. "marg_export", "manufacturer_price_list"). Scraped sources are not allowed.
  source        text NOT NULL,
  filename      text,
  uploaded_by   uuid NOT NULL REFERENCES users (id),
  dry_run       boolean NOT NULL,
  status        text NOT NULL CHECK (status IN ('validated', 'applied', 'rejected')),
  total_rows    integer NOT NULL,
  valid_rows    integer NOT NULL,
  created_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  errors        jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku             text NOT NULL UNIQUE,
  name            text NOT NULL,
  generic_name    text,
  manufacturer_id uuid NOT NULL REFERENCES manufacturers (id),
  strength        text,
  dosage_form     text,
  pack_size       text,
  hsn_code        text CHECK (hsn_code IS NULL OR hsn_code ~ '^[0-9]{4,8}$'),
  gst_rate_bps    integer CHECK (gst_rate_bps IN (0, 500, 1200, 1800, 2800)),
  mrp_paise       bigint CHECK (mrp_paise IS NULL OR mrp_paise > 0),
  schedule        text NOT NULL DEFAULT 'none' CHECK (schedule IN ('none', 'G', 'H', 'H1', 'X')),
  cold_chain      boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'restricted', 'discontinued')),
  source          text NOT NULL,
  last_import_run_id uuid REFERENCES catalog_import_runs (id),
  -- Denormalised search text: name, generic, manufacturer, strength, form, sku and aliases.
  search_text     text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX products_search_trgm_idx ON products USING gin (search_text gin_trgm_ops);
CREATE INDEX products_name_trgm_idx ON products USING gin (lower(name) gin_trgm_ops);
CREATE INDEX products_manufacturer_idx ON products (manufacturer_id);

CREATE TABLE product_aliases (
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  alias      text NOT NULL,
  PRIMARY KEY (product_id, alias)
);

CREATE INDEX product_aliases_trgm_idx ON product_aliases USING gin (lower(alias) gin_trgm_ops);
