# Product Requirements (MVP)

## Roles
- Retailer: onboarding, KYC, search, cart, checkout, order tracking, invoices, reorder, complaints.
- KYC reviewer: verify licence/store documents; approve, reject or request resubmission.
- Support/order operator: customer support and permitted assisted ordering.
- Catalog/inventory operator: imports, product master, stock-sync monitoring.
- Picker/packer: pick, short-pick exception, pack verification.
- Billing operator: confirm billing through Marg or an approved connector.
- Procurement: supplier quotes, purchase orders, receipt and special-order updates.
- Dispatcher: assign/group delivery stops.
- Rider: assigned deliveries only, navigation, OTP/proof, COD collection.
- Finance/admin: payment and COD reconciliation, reporting.
- Super admin: roles, configuration, audit.

## Onboarding/KYC
Phone OTP; business/owner details; store address/map pin; drug licence details and document; store image; video-KYC status. States: draft, submitted, under_review, needs_resubmission, approved, rejected, suspended. Only approved retailers with verified store address may order. First-delivery verification is an extra check, not a replacement for licence verification.

## Catalog/search
Search brand, generic/salt, manufacturer, strength, form, pack size, internal code. Show availability and last-sync freshness. Statuses: in_stock, low_stock, out_of_stock, special_order_request, restricted, discontinued. Never imply clinical equivalence. Do not use scraped third-party catalogues in production without permission/legal review.

## Inventory
Marg 9.0 desktop is expected source, but integration method is unknown. First investigate official API/export options. If only imports are possible, show last-sync time and handle stale stock conservatively. Support batch, expiry, reserved/quarantined quantity where reliable. Avoid overselling with transactional reservation/recheck. FEFO where data and warehouse process support it. Do not enable cold-chain SKUs until handling and delivery controls are validated.

## Cart/pricing
Configurable minimum order (initial ₹3,000), delivery charge (initial ₹50), order slabs, SKU/brand eligibility, effective dates, schemes, stackability, caps and exclusions. Show subtotal, discount, scheme benefit, tax, delivery fee and payable amount. Discount schedule is unresolved; build engine but do not activate production percentages until owner signs off. Store pricing snapshot on order.

## Checkout/payment
Prepaid online or eligible COD; no credit. Payment provider is undecided (not GoKwik, which is Sanatan Sansaar's): validate B2B merchant fit and sandbox/API docs; use provider adapter. Verify payment server-side/webhook; never trust client redirect. COD requires approved retailer, verified store within eligible zone, minimum order met, admin eligibility and amount not above ₹10,000. Default threshold basis is final payable unless owner confirms otherwise; clarify behavior at exactly ₹10,000. Separate payment and fulfillment statuses.

## Orders
Suggested flow: placed → payment_pending/payment_confirmed → accepted → picking → short_pick_review if needed → packed → ready_for_dispatch → assigned_to_rider → out_for_delivery → delivered. Exceptions: cancel_requested, cancelled, delivery_failed, partially_fulfilled (if approved), returned, closed. All transitions audited. Never silently remove unavailable items. Mixed in-stock/special-order splitting is an open decision; safest MVP is a separate special-order request unless operations approve otherwise.

## Special orders/procurement
Unavailable items create internal procurement request. ETA says “to be confirmed” until supplier confirms. Procurement records supplier, quote, PO, ETA, receipt, quantity, batch/expiry and outcome. Goods must be received and checked at Taneja warehouse before dispatch. No direct supplier-to-retailer fulfillment.

## Warehouse/delivery
Pick list, quantity confirmation, short-pick exception, pack checklist, batch/expiry checks where relevant, handoff record. Dispatcher assigns riders; delivery interface shows assigned stops and approved store address. OTP recommended for proof. Rider cannot edit order total. COD mismatch becomes an exception. Delivery currently around 1–8 PM; make schedule configurable.

## Returns
Retailer submits item, quantity, reason and evidence. Authorized review before pickup. Record return authorization, pickup, inspection, GR reference, disposition and replacement. Return eligibility depends on approved policy, product, batch and supplier rules. No automatic cash refund in MVP unless separately approved. Quarantine until disposition.

## Notifications/admin
KYC, payment, order, special-order, dispatch, delivery and return notifications through configured providers. Dashboard for KYC queue, order state, stock sync, short picks, procurement backlog, delivery exceptions, returns and reconciliation. Audit privileged actions.

## Non-functional
Responsive and bilingual; secure auth/RBAC; server validation; private KYC storage; backups/monitoring; clear loading/empty/error/retry states. Legal/regulatory review required before launch.
