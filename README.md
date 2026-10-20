# Taneja B2B

B2B medicine ordering and distribution platform for Taneja Drug Agency, Samastipur. "Taneja B2B" is a placeholder name.

Licensed retailers order from Taneja's warehouse; Taneja is the only fulfilment point. The spec lives in [`docs/spec`](docs/spec) and the build rules in [`CLAUDE.md`](CLAUDE.md).

## Status

Phase 1 (foundation) of the [build sequence](prompts/02_BUILD_SEQUENCE.md): API skeleton, environment validation, migrations, audit log, structured logging with redaction, stable error codes, health checks, checkout/COD rules and CI. No retailer-facing features yet.

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
npm run dev -w @taneja/api      # http://localhost:3000/health
```

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
