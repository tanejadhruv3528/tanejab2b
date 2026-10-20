# Initial Logical Data Model
Use UUID IDs where compatible, timestamps, migrations, indexes and foreign keys. Money uses integer paise or fixed-precision decimal, never float.

- `users`: phone, email, name, language, status.
- `roles`, `user_roles`: role and scope assignments.
- `retailer_accounts`: business/trade name, owner/contact, GSTIN optional, status, approval.
- `retailer_licenses`: retailer, licence type/number, expiry, private document object key, review state.
- `store_locations`: retailer, address, postal code, lat/long, service zone, verified flag.
- `kyc_reviews`: reviewer, decision, reason, timestamps.
- `products`: SKU, brand, generic/composition, manufacturer, strength, form, pack size, HSN/tax fields when verified, source.
- `product_aliases`, `manufacturers`.
- `inventory_batches`: product, batch, expiry, MRP, rates, on-hand/reserved/quarantined quantities, location, source timestamp.
- `inventory_sync_runs`: source, timestamps, status, counts/errors.
- `pricing_rules`, `product_schemes`: eligibility, dates, thresholds, priority, stackability, caps, status.
- `price_quotes`: retailer, totals, pricing version, expiry.
- `orders`, `order_items`, `order_events`: status history and price/tax/scheme snapshots.
- `payments`, `payment_webhook_events`, `cod_reconciliations`.
- `suppliers`, `supplier_products`, `procurement_requests`, `purchase_orders`, `purchase_order_items`.
- `warehouse_tasks`, `delivery_assignments`, `delivery_proofs`.
- `return_requests`, `return_items`.
- `notifications`, `audit_logs`, `app_settings`.

KYC files are private object storage, not public URLs. Supplier cost never reaches retailer API. Audit inventory adjustments. Keep order pricing snapshots immutable.
