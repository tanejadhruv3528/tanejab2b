# Proposed Architecture
Start with a modular monolith, not microservices. Preserve existing repo stack after audit.
- Retailer app: cross-platform mobile or responsive PWA; decide after repo audit.
- Delivery interface: role-restricted mobile/PWA.
- Admin/warehouse/procurement web console.
- Backend API and PostgreSQL.
- Private object storage for KYC/proof documents.
- Background jobs for sync, notifications, imports and webhooks.
- Staging and production separated; secrets in environment/secrets manager; backups with restore test.

## Modules
Identity/RBAC, KYC, catalogue, inventory/batches, pricing/schemes, cart/orders/payments, procurement, warehouse, delivery, returns/GR, notifications, reports/audit, integrations.

## Marg plan
Do not invent an API or connect to undocumented DB. Contact Marg/vendor for official integration docs and permitted exports. Obtain anonymized sample export, build read-only adapter/import validation, reconcile product identifiers, expose last-sync status. Write invoices/orders back only if supported and tested; otherwise Marg remains billing source of truth with controlled reconciliation.

## Payment/catalog
Payment-provider interface with session creation, server verification, signed webhook handling and reconciliation. Provider is undecided (GoKwik belongs to Sanatan Sansaar and is out of scope here). Use authorized manufacturer/distributor/catalogue data; track source and import history. No production scraping without permission/legal review.
