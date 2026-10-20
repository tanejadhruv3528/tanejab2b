-- Foundation: configurable settings and an append-only audit log.

CREATE TABLE app_settings (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]*$'),
  value       jsonb NOT NULL,
  description text,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_role    text,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  before_state  jsonb,
  after_state   jsonb,
  reason        text,
  request_id    text,
  ip_address    inet
);

CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, occurred_at DESC);

-- Audit rows are evidence: block updates and deletes at the database level.
CREATE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$;

CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- Initial owner proposals. Amounts are in paise. Discounts stay disabled until the owner
-- confirms the slab rates (open decision #2: 3/5/7% vs 23/25/27%).
INSERT INTO app_settings (key, value, description) VALUES
  ('checkout.policy',
   '{"minimumOrderPaise": 300000, "minimumOrderBasis": "subtotal", "deliveryFeePaise": 5000, "codLimitPaise": 1000000, "codLimitInclusive": true, "codLimitBasis": "payable"}',
   'Minimum order, delivery fee and COD limit. Proposed by owner, pending confirmation.'),
  ('pricing.discounts_enabled', 'false',
   'Order-value discount slabs. Must stay false until the owner confirms exact rates.'),
  ('delivery.window',
   '{"start": "13:00", "end": "20:00", "timezone": "Asia/Kolkata"}',
   'Current delivery hours (about 1 PM to 8 PM).');
