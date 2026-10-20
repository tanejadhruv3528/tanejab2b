# Claude Code Rules
Build a secure B2B ordering and distribution platform for Taneja Drug Agency. Read the relevant docs before every task. Audit existing code before edits; preserve viable stack; make small changes; add tests; report changed files, tests, assumptions, and blockers.

## Business rules
- Approved retailer accounts only; deliver only to verified pharmacy premises.
- Taneja warehouse is the only fulfillment point. Supplier data/costs are internal and never shown to retailers.
- No credit/credit ledger in MVP.
- Prepaid or eligible COD only; COD blocked above ₹10,000 and additionally controlled by service zone/admin restrictions.
- ₹3,000 minimum order and ₹50 delivery charge are configurable initial proposals.
- Discount and company scheme rules must be configurable; conflicting percentages are unresolved, so do not activate production rates.
- Special-order ETA remains unconfirmed until procurement confirms it; 2 working days is only a planning estimate.
- Do not claim live Marg sync, stock, payment success, licence verification, or GPS tracking unless genuinely implemented and tested.
- Do not use unapproved scraping for production medicine catalogue.
- No clinical advice or automated therapeutic substitution.

## Engineering
- Enforce permissions server-side; validate all inputs; audit privileged changes.
- Use transactional order/stock operations, idempotency for order/payment events, and paise-safe money arithmetic.
- Store KYC files privately; never log sensitive documents/secrets; never store card data.
- Use migrations and tests. No production deployment, destructive migration, or paid service action without explicit approval.

## Project boundaries
- Taneja B2B is a separate entity from Sanatan Sansaar. Ideas and code patterns may be borrowed, but never its processes, merchant accounts, payment provider (GoKwik), credentials or data.
- The payment provider for Taneja is undecided; keep payments behind a provider adapter.

## Repo layout
- `apps/api`: Fastify + TypeScript HTTP API, PostgreSQL via `pg`, plain SQL migrations in `apps/api/migrations`.
- `apps/retailer`: React + Vite retailer PWA (English/Hindi); talks to the API via `/api`.
- `packages/domain`: pure business rules (money in paise, checkout/COD rules). No I/O.
- `docs/spec`: the owner's spec pack (PRD, architecture, data model, API/security tests, open decisions).
- `prompts`: phased build prompts.

## Commands
- `npm install`, `npm run typecheck`, `npm test`
- `npm run db:migrate -w @taneja/api`, `npm run dev -w @taneja/api`, `npm run dev -w @taneja/retailer`
- `npm run user:grant -w @taneja/api -- <mobile> <role>` to bootstrap staff roles
