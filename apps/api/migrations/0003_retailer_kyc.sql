-- Retailer onboarding and KYC: accounts, store locations, licences, private documents, reviews.

CREATE TABLE retailer_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One retailer account per owner login in the MVP.
  owner_user_id    uuid NOT NULL UNIQUE REFERENCES users (id),
  business_name    text,
  owner_name       text,
  email            text,
  gstin            text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN
                     ('draft', 'submitted', 'under_review', 'needs_resubmission', 'approved', 'rejected', 'suspended')),
  video_kyc_status text NOT NULL DEFAULT 'not_started' CHECK (video_kyc_status IN
                     ('not_started', 'scheduled', 'completed', 'failed', 'waived')),
  cod_allowed      boolean NOT NULL DEFAULT true,
  submitted_at     timestamptz,
  approved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX retailer_accounts_status_idx ON retailer_accounts (status, submitted_at);

CREATE TABLE store_locations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_account_id uuid NOT NULL UNIQUE REFERENCES retailer_accounts (id),
  address_line1       text NOT NULL,
  address_line2       text,
  landmark            text,
  city                text NOT NULL,
  district            text NOT NULL,
  state               text NOT NULL DEFAULT 'Bihar',
  postal_code         text NOT NULL CHECK (postal_code ~ '^[1-9][0-9]{5}$'),
  latitude            numeric(9, 6) CHECK (latitude BETWEEN -90 AND 90),
  longitude           numeric(9, 6) CHECK (longitude BETWEEN -180 AND 180),
  service_zone        text,
  verified            boolean NOT NULL DEFAULT false,
  verified_by         uuid REFERENCES users (id),
  verified_at         timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE retailer_licenses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_account_id uuid NOT NULL UNIQUE REFERENCES retailer_accounts (id),
  license_type        text NOT NULL CHECK (license_type IN ('form_20', 'form_21', 'form_20b', 'form_21b', 'form_20_21', 'other')),
  license_number      text NOT NULL,
  valid_until         date NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Metadata only. File bytes live in private object storage under storage_key, never at a public URL.
CREATE TABLE kyc_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_account_id uuid NOT NULL REFERENCES retailer_accounts (id),
  kind                text NOT NULL CHECK (kind IN ('drug_license', 'store_photo', 'gst_certificate', 'other')),
  storage_key         text NOT NULL UNIQUE,
  content_type        text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes          integer NOT NULL CHECK (size_bytes > 0),
  sha256              text NOT NULL,
  uploaded_by         uuid NOT NULL REFERENCES users (id),
  -- Replaced documents are kept for the audit trail but hidden from the current set.
  superseded_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX kyc_documents_account_idx ON kyc_documents (retailer_account_id, kind) WHERE superseded_at IS NULL;

CREATE TABLE kyc_reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_account_id uuid NOT NULL REFERENCES retailer_accounts (id),
  reviewer_user_id    uuid NOT NULL REFERENCES users (id),
  from_status         text NOT NULL,
  to_status           text NOT NULL,
  reason              text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX kyc_reviews_account_idx ON kyc_reviews (retailer_account_id, created_at DESC);

ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_retailer_account_fk
  FOREIGN KEY (scope_retailer_account_id) REFERENCES retailer_accounts (id);
