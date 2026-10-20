# Prompt 2 — Phased Build Sequence
After audit approval, implement one phase at a time. For each phase: restate scope, inspect relevant code, plan files, implement smallest coherent change, add tests, run tests, report results and manual setup. Do not proceed to the next phase without review.

1. Foundation: env validation, migrations, logging, errors, health check, CI.
2. Auth/RBAC: secure roles and tenant isolation.
3. Retailer onboarding/KYC: private uploads, review queue, approved-only ordering.
4. Catalogue: authorized data import, validation, search and aliases.
5. Inventory: Marg adapter only after official docs/sample export; stale-stock indicators.
6. Pricing/cart: configurable rules; do not activate unresolved discount rates.
7. Orders/payments: COD and prepaid, server verification, idempotency.
8. Warehouse/procurement: pick/pack, short pick, receive stock at Taneja warehouse.
9. Delivery: assigned stops, OTP/proof, COD collection/reconciliation.
10. Returns/GR: review, pickup, inspection, disposition, replacement.
11. Notifications/admin dashboards.
12. Security hardening, UAT, staging and pilot readiness.

Never fake a real integration. Use dev mocks only with obvious labels. Do not deploy production or run destructive migrations without explicit approval.
