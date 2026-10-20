# API Outline, Security and Tests

## API outline
`POST /auth/otp/request`, `POST /auth/otp/verify`, `GET /me`
`POST /retailer/onboarding`, `POST /retailer/kyc/submit`, `GET /retailer/kyc/status`
`GET /catalog/search`, `GET /catalog/products/:id`
`POST /cart/quote`, `POST /orders`, `GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel-request`
`POST /payments/session`, `GET /payments/:id/status`, `POST /payments/webhooks/:provider`
`GET /admin/kyc/queue`, `POST /admin/kyc/:id/decision`
`GET /warehouse/tasks`, `POST /warehouse/tasks/:id/pick-confirmation`, `POST /warehouse/tasks/:id/pack-confirmation`
`GET /procurement/requests`, `POST /procurement/purchase-orders`, `POST /procurement/purchase-orders/:id/receive`
`GET /delivery/assignments`, `POST /delivery/assignments/:id/confirm`, `POST /delivery/assignments/:id/cod-collected`
`POST /returns`, `POST /returns/:id/decision`

All endpoints need server-side role checks, schema validation, pagination and stable error codes. Use idempotency for order creation and webhooks.

## Security/compliance launch checklist
- Qualified Indian pharma, tax, privacy and payment review.
- Verify licences, validity and permitted activities.
- Private KYC storage, least privilege, audit logs, retention policy, secure document access.
- Product restrictions for prescription/scheduled/cold-chain/recall/expiry handled by qualified compliance owner.
- No patient medical advice or automated substitution.
- Payment webhook signature verification; no card storage.
- No unapproved third-party scraping.
- Backup/restore test, incident process and security tests before launch.

## Critical tests
- COD disabled above ₹10,000; test exactly ₹10,000 after policy decision.
- Minimum ₹3,000 boundary.
- Discount thresholds below/at/above each boundary; schemes stacking/expiry.
- Two concurrent orders cannot reserve the same last unit.
- Duplicate order request/webhook is idempotent.
- Client redirect cannot mark payment successful.
- Unapproved retailer and unverified store cannot order.
- Retailer cannot access another retailer's orders.
- Rider sees only assigned deliveries.
- Supplier costs never appear in retailer response.
- Stale inventory visibly flagged.
- Short pick, supplier failure, failed delivery and return are audited.
