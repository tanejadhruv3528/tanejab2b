-- Identity: users, roles, phone OTP challenges and sessions.

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL UNIQUE CHECK (phone ~ '^\+91[6-9][0-9]{9}$'),
  name        text,
  email       text,
  language    text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'hi')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- Fixed role catalogue from the PRD. Adding a role needs a migration so it is reviewed.
CREATE TABLE roles (
  name        text PRIMARY KEY,
  description text NOT NULL,
  is_staff    boolean NOT NULL
);

INSERT INTO roles (name, description, is_staff) VALUES
  ('retailer',          'Approved pharmacy retailer: orders, tracking, returns', false),
  ('kyc_reviewer',      'Verifies retailer licence and store documents', true),
  ('support_operator',  'Customer support and permitted assisted ordering', true),
  ('catalog_operator',  'Product master, imports and stock-sync monitoring', true),
  ('picker_packer',     'Warehouse pick, short-pick exceptions and packing', true),
  ('billing_operator',  'Confirms billing through Marg or an approved connector', true),
  ('procurement',       'Supplier quotes, purchase orders and receipts', true),
  ('dispatcher',        'Assigns and groups delivery stops', true),
  ('rider',             'Sees and completes assigned deliveries only', true),
  ('finance_admin',     'Payment and COD reconciliation, reporting', true),
  ('super_admin',       'Roles, configuration and audit', true);

CREATE TABLE user_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),
  role        text NOT NULL REFERENCES roles (name),
  -- Retailer-scoped roles point at the retailer account (added in the onboarding phase).
  scope_retailer_account_id uuid,
  granted_by  uuid REFERENCES users (id),
  granted_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX user_roles_unique_idx
  ON user_roles (user_id, role, coalesce(scope_retailer_account_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE otp_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text NOT NULL,
  code_hash    text NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  request_ip   inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX otp_challenges_phone_idx ON otp_challenges (phone, created_at DESC);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),
  -- Only a SHA-256 hash of the bearer token is stored.
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  user_agent  text,
  ip_address  inet
);

CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
