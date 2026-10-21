# Taneja B2B

B2B medicine ordering and distribution platform for Taneja Drug Agency, Samastipur. "Taneja B2B" is a placeholder name.

Licensed retailers order from Taneja's warehouse; Taneja is the only fulfilment point. The spec lives in [`docs/spec`](docs/spec) and the build rules in [`CLAUDE.md`](CLAUDE.md).

## Status

- Phase 1 (foundation): API skeleton, environment validation, migrations, audit log, structured logging with redaction, stable error codes, health checks, checkout/COD rules and CI.
- Phase 2 (auth/roles): phone OTP login, sessions, `/me`, the PRD's staff roles, and super-admin user management. SMS is a development stub that prints codes to the server log; staging/production refuse to start until a real SMS/DLT provider is added.
- Phase 3 (retailer onboarding/KYC): business, store address with map pin, drug licence and GSTIN details; private licence/store-photo uploads; submit for review; reviewer queue, audited document viewing, and decisions (approve, send back, reject, suspend, reinstate). Approval requires a verified store and an unexpired licence, and grants the retailer role for that account. Files are stored on local disk in development only; staging/production refuse to start until a private storage bucket is configured.
- Phase 4 (catalogue): CSV import from authorised sources only (Marg export, manufacturer/distributor lists, manual entry) with dry-run validation, whole-file rejection on any error, upsert by SKU and import history; typo-tolerant search by brand, salt, manufacturer, strength, SKU and aliases (incl. Hindi); restricted, cold-chain and schedule flags. Search results carry an availability status.
- Phase 5 (inventory): stock snapshots by batch (expiry, MRP, rate, location) imported as CSV from a Marg export or a manual count; dry run, whole-file rejection, older exports cannot overwrite newer ones, unknown SKUs and oversold batches reported. Availability (in stock / low / out / restricted / discontinued) and last-sync time with a stale flag on every product; exact quantities only for staff. Earliest-expiry-first reservation with row locks so concurrent orders cannot take the same last unit; batches inside the minimum shelf life are not sold. Every movement is logged. The real Marg export column layout still needs a sample file.
- Phase 6 (cart and pricing): one server-side cart per approved retailer; quotes priced from the earliest-expiry sellable batches at Taneja's selling rate, GST added per line (rates are assumed GST-exclusive until checked against Marg invoices), ₹50 delivery, ₹3,000 minimum and COD eligibility (blocked above ₹10,000, outside service zones or when disabled by admin). Restricted, discontinued, cold-chain, untaxed, unpriced and short-stock lines are shown with a reason and block checkout, never silently dropped. Quotes are stored for 15 minutes so checkout can charge the price shown. Order-value discount slabs can be drafted and activated (super admin, audited) but stay off globally until the owner confirms the rates.
- Retailer app (`apps/retailer`): phone-first installable web app (React + Vite) in English and Hindi with OTP login, pharmacy registration (details, store location from the phone's GPS, licence, document uploads, submit and status), catalogue search with availability, and the cart with GST, delivery, minimum order, COD eligibility and per-item problems. Hindi text is a first draft that needs a native-speaker review.
- Phase 7 (orders and payments): orders placed from a quote with an `Idempotency-Key` (a retry returns the same order), re-checked prices, stock and payment eligibility inside one transaction, earliest-expiry stock reservation and a frozen delivery address. Fulfilment and payment statuses are separate, every change is logged as an order event, and staff accept/cancel actions are audited. COD is re-checked at order time. Online payment sits behind a provider adapter: with no provider configured (the default) prepaid checkout is refused and hidden in the app; a development-only `dev_fake` provider exercises signed, de-duplicated webhooks. Only a verified webhook can mark an order paid. Unpaid prepaid orders are cancelled after 30 minutes and their stock released; payments arriving after cancellation are flagged for refund. Retailers can cancel before acceptance and request cancellation after. The retailer app has checkout and order history.
- Phase 8a (warehouse): accepting an order creates a pick task listing each reserved batch (earliest expiry first, with shelf location). Pickers claim a task, confirm the quantity picked per line, and must give a reason for any shortfall. Short units come off the order's reservation and are quarantined until a stock check releases them; the order goes to short-pick review, where support either covers the gap from other batches of the same product or cancels. Partial fulfilment is not offered until the owner approves it. Packing needs a package count and every checklist item ticked. Billing staff then type in the Marg invoice number and total (nothing is sent to Marg); a total that differs from the order needs a reason. Invoiced units leave stock and the order becomes ready for dispatch. Picking pauses while a retailer's cancellation request is open, and support can decline the request. All steps are audited.
- Phase 8b (procurement): retailers can request a special order for a catalogue product or a typed-in medicine name. Restricted, discontinued and cold-chain products cannot be requested, and each retailer can have up to 20 open requests. The retailer sees the status and an ETA only once procurement records a date confirmed by the supplier; until then it reads "to be confirmed". Supplier names, costs and internal notes never reach retailer endpoints. Procurement keeps suppliers, raises purchase orders (linking typed-in requests to a catalogue product), marks them sent (nothing is sent automatically), cancels them (requests go back to the queue) and closes requests a supplier cannot meet, with a reason. Warehouse staff check deliveries in by batch and expiry, with a reason for any rejected units. Accepted units go on hand straight away, but a new batch has no selling rate until a Marg stock import supplies one, so it is not sold before billing has it. Stock without a selling rate no longer counts as available or reservable anywhere. All procurement actions are audited.
- Phase 9 (delivery): dispatchers assign orders that are ready for dispatch to active riders, unassign them (the order goes back to the queue), and send failed deliveries out again. Riders see only their own live stops: store name, the frozen verified address, the retailer's phone, items and quantities, package count, and the amount to collect (no line prices). When a rider starts a stop, the retailer gets a 6-digit delivery code by SMS; only its hash is stored. Five wrong tries lock the code until the retailer asks for a new one (at most five sends). Delivery is confirmed with the code, and for COD the rider records cash or UPI and the amount in the same step. The rider cannot change the order total. A short or excess collection is delivered but stays COD due and is logged as a discrepancy for finance. UPI references are typed in and not verified with any bank. Failed attempts need a reason and are shown in the retailer's order history. Finance reconciles what each rider hands over; any difference needs a note. Delivery hours (1 to 8 PM) are a setting shown to riders. There is no GPS tracking. The delivery SMS needs its own DLT template once a provider is chosen.
- Phase 10 (returns): retailers request a return for lines of their own delivered orders, within a configurable window (7 days, a proposal until the return policy is approved), up to the delivered quantity less anything already being returned. Each line needs a reason, and an optional batch. Up to five private photos or PDFs can be attached while the request awaits review. Viewing them is audited. Support approves or rejects with a reason the retailer can see. Dispatch schedules pickup with a rider, and the warehouse records arrival; goods stay off sale until inspection. Inspection records the accepted quantity and disposition for every line (restock into a known batch of the same product, return to supplier, or destroy), plus the Marg GR number and the outcome (credit note or replacement, by reference, or no action). No money moves and there are no automatic refunds. Retailers see status, reasons and the outcome, not internal dispositions or notes. Every step is audited.

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
| GET, DELETE | `/cart` | approved retailers (own cart) |
| PUT | `/cart/items/:productId` `{quantity}` (0 removes) | approved retailers |
| POST | `/cart/quote` → stored quote with expiry | approved retailers |
| POST | `/orders` `{quoteId, paymentMethod}` + `Idempotency-Key` header | approved retailers |
| GET | `/orders`, `/orders/:id` | approved retailers (own orders only) |
| POST | `/orders/:id/cancel-request` | approved retailers |
| POST | `/payments/session` `{orderId}`; GET `/payments/:id/status` | approved retailers (own orders) |
| POST | `/payments/webhooks/:provider` (signed raw body) | payment provider |
| GET | `/admin/orders?status=`, `/admin/orders/:id` | support, warehouse, dispatch, billing, finance, super_admin |
| POST | `/admin/orders/:id/accept`, `/admin/orders/:id/cancel` | support_operator, super_admin (audited) |
| POST | `/admin/orders/:id/cancel-request/decline`, `/admin/orders/:id/short-pick/reallocate` `{reason}` | support_operator, super_admin (audited) |
| GET | `/warehouse/tasks?status=`, `/warehouse/tasks/:id` | picker_packer, super_admin |
| POST | `/warehouse/tasks/:id/start`, `/pick-confirmation`, `/pack-confirmation` | picker_packer, super_admin (audited) |
| POST | `/billing/orders/:id/invoice` `{invoiceNumber, amountPaise, mismatchReason?}` | billing_operator, super_admin (audited) |
| POST | `/admin/inventory/batches/:batchId/quarantine/release` `{quantity, reason}` | catalog_operator, super_admin (audited) |
| GET, POST | `/special-orders`; POST `/special-orders/:id/cancel` | approved retailers (own requests) |
| POST | `/orders/:id/delivery-otp` (resend code) | approved retailers (own orders) |
| GET, POST | `/returns`; GET `/returns/:id`; POST `/returns/:id/evidence` (raw JPEG/PNG/PDF), `/returns/:id/cancel` | approved retailers (own returns) |
| POST | `/returns/:id/decision` `{decision, reason}`; GET `/admin/returns/:id/evidence/:evidenceId` | support_operator, super_admin (audited) |
| GET | `/admin/returns?status=`, `/admin/returns/:id` | support, dispatch, warehouse, finance, super_admin |
| POST | `/admin/returns/:id/pickup` | dispatcher, super_admin (audited) |
| POST | `/admin/returns/:id/receive`, `/admin/returns/:id/inspection` | picker_packer, super_admin (audited) |
| GET, POST | `/dispatch/assignments`; POST `/dispatch/assignments/:id/cancel`, `/dispatch/orders/:id/redispatch` | dispatcher, super_admin (audited) |
| GET | `/delivery/assignments` | rider (own stops only) |
| POST | `/delivery/assignments/:id/start`, `/confirm` `{otp, cod?}`, `/fail` `{reason, note?}` | rider (own stops; failures audited) |
| GET | `/finance/cod-collections?status=`; POST `/finance/cod-collections/:id/reconcile` | finance_admin, super_admin (audited) |
| GET, POST | `/procurement/requests`; POST `/procurement/requests/:id/eta`, `/close` | procurement, super_admin (ETA and close audited) |
| GET, POST | `/procurement/suppliers` | procurement, super_admin (audited) |
| POST | `/procurement/purchase-orders`, `/:id/send`, `/:id/cancel` | procurement, super_admin (audited) |
| GET | `/procurement/purchase-orders`, `/:id`; POST `/:id/receive` | procurement, picker_packer, super_admin (receipt audited) |
| GET | `/admin/pricing/rules` | super_admin, catalog_operator, finance_admin |
| POST | `/admin/pricing/rules` (draft slab) | super_admin, catalog_operator (audited) |
| POST | `/admin/pricing/rules/:id/status` (activate/retire + reason) | super_admin (audited) |

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
npm run dev -w @taneja/retailer # http://localhost:5173 (proxies /api to the API)
npm run build:demo -w @taneja/retailer # sample-data demo that runs without the API (dist-demo/)
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
