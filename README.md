# Taneja B2B

B2B medicine ordering and distribution platform for Taneja Drug Agency, Samastipur. "Taneja B2B" is a placeholder name.

Licensed retailers order from Taneja's warehouse; Taneja is the only fulfilment point. The spec lives in [`docs/spec`](docs/spec) and the build rules in [`CLAUDE.md`](CLAUDE.md).

## Status

- Phase 1 (foundation): API skeleton, environment validation, migrations, audit log, structured logging with redaction, stable error codes, health checks, checkout/COD rules and CI.
- Phase 2 (auth/roles): phone OTP login, sessions, `/me`, the PRD's staff roles, and super-admin user management. SMS is a development stub that prints codes to the server log; staging/production refuse to start until a real SMS/DLT provider is added.
- Phase 3 (retailer onboarding/KYC): business, store address with map pin, drug licence and GSTIN details; private licence/store-photo uploads; submit for review; reviewer queue, audited document viewing, and decisions (approve, send back, reject, suspend, reinstate). Approval requires a verified store and an unexpired licence, and grants the retailer role for that account. Files are stored on local disk in development only; staging/production refuse to start until a private storage bucket is configured.
- Phase 4 (catalogue): CSV import from authorised sources only (Marg export, manufacturer/distributor lists, manual entry) with dry-run validation, whole-file rejection on any error, upsert by SKU and import history; typo-tolerant search by brand, salt, manufacturer, strength, SKU and aliases (incl. Hindi); restricted, cold-chain and schedule flags. Search results carry an availability status.
- Phase 5 (inventory): stock snapshots by batch (expiry, MRP, rate, location) imported as CSV from a Marg export or a manual count; dry run, whole-file rejection, older exports cannot overwrite newer ones, unknown SKUs and oversold batches reported. Availability (in stock / low / out / restricted / discontinued) and last-sync time with a stale flag on every product; exact quantities only for staff. Earliest-expiry-first reservation with row locks so concurrent orders cannot take the same last unit; batches inside the minimum shelf life are not sold. Every movement is logged. The real Marg export column layout still needs a sample file.

No retailer-facing screens yet.

## API so far

| Method | Path | Who |
| --- | --- | --- |
| GET | `/health`, `/health/ready` | anyone |
| POST | `/auth/otp/request` `{phone}` | anyone (rate limited) |
| POST | `/auth/otp/verify` `{phone, code}` → `{token, user, roles}` | anyone |
| POST | `/auth/logout` | logged in |
| GET, PATCH | `/me` (name, language `en`/`hi`) | logged in |
| GET, POST | `/admin/users` | super_admin |
| GET | `/admin/users/:id` | super_admin |
| POST, DELETE | `/admin/users/:id/roles[/:role]` | super_admin (audited) |
| POST | `/admin/users/:id/status` | super_admin (audited) |
| GET, PUT | `/retailer/onboarding` | logged in (own account only) |
| POST | `/retailer/kyc/documents/:kind` (raw JPEG/PNG/PDF body, max 5 MB) | logged in, while editable |
| POST | `/retailer/kyc/submit` | logged in |
| GET | `/retailer/kyc/status` | logged in |
| GET | `/admin/kyc/queue`, `/admin/kyc/:accountId` | kyc_reviewer, super_admin |
| GET | `/admin/kyc/:accountId/documents/:documentId` | kyc_reviewer, super_admin (every view audited) |
| POST | `/admin/kyc/:accountId/decision` | kyc_reviewer, super_admin (audited) |
| GET | `/catalog/search?q=`, `/catalog/products/:id` | approved retailers, staff |
| POST | `/admin/catalog/imports?source=&dryRun=` (text/csv body) | catalog_operator, super_admin |
| GET | `/admin/catalog/imports` | catalog_operator, super_admin |
| PATCH | `/admin/catalog/products/:id` (status + reason) | catalog_operator, super_admin (audited) |
| POST | `/admin/inventory/imports?source=&asOf=&dryRun=` (text/csv body) | catalog_operator, super_admin (audited) |
| GET | `/admin/inventory/imports` | catalog_operator, super_admin |
| GET | `/admin/inventory/products/:productId` (batches) | warehouse, procurement, support, catalogue staff |

Catalogue CSV columns: `sku,name,manufacturer` required; optional `generic_name,strength,dosage_form,pack_size,hsn_code,gst_rate,mrp,schedule,cold_chain,status,aliases` (aliases separated by `|`).

Stock CSV columns: `sku,batch,expiry,qty` required (expiry as `2027-03-31` or `03/2027`); optional `mrp,rate,location`. Each file is a full snapshot for the products it lists.

Send the token as `Authorization: Bearer <token>`.

## Stack

| Part | Choice |
| --- | --- |
| API | Node 22, TypeScript, Fastify 5 (`apps/api`) |
| Database | PostgreSQL 16, forward-only SQL migrations (`apps/api/migrations`) |
| Business rules | Pure TypeScript, no I/O (`packages/domain`) |
| Tests | Vitest; DB tests run against a real Postgres |
| Apps (later phases) | Retailer PWA (English/Hindi), admin/warehouse console, rider interface |

## Local setup

```bash
docker compose up -d            # Postgres with taneja_dev and taneja_test databases
npm install
cp apps/api/.env.example apps/api/.env
npm run db:migrate -w @taneja/api
npm run user:grant -w @taneja/api -- 9876543210 super_admin   # first admin
npm run dev -w @taneja/api      # http://localhost:3000/health
```

In development, OTP codes appear in the server log as `[DEV SMS - NOT SENT]`.

Run checks:

```bash
npm run typecheck
TEST_DATABASE_URL=postgres://taneja:taneja@localhost:5432/taneja_test npm test
```

DB integration tests are skipped when `TEST_DATABASE_URL` is unset. They reset the `public` schema of that database, so never point it at a real one.

## Business rules already encoded

- Money is integer paise only.
- Minimum order ₹3,000 and delivery fee ₹50 (configurable in `app_settings`, pending owner confirmation).
- No credit. Prepaid or COD; COD blocked above ₹10,000 payable, outside the COD service zone, or when disabled by admin. Whether exactly ₹10,000 is allowed and which amount the limit applies to are configurable open decisions.
- Discounts are disabled until the owner confirms the slab rates.
- Only approved retailers with a verified store can order.
- `audit_logs` is append-only at the database level.

## Not in scope

Taneja B2B is separate from Sanatan Sansaar. Its payment provider (GoKwik), processes, accounts and data are not used here. The payment provider for Taneja is still to be chosen.
