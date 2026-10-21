import type { PoolClient } from 'pg';
import type { SmsSender } from './auth/sms.js';
import { generateOtpCode, hashOtp, safeEqualHex } from './auth/tokens.js';
import { withTransaction, type Db } from './db.js';
import { AppError } from './errors.js';
import { lockOrder, setStatus, type OrderRow } from './orders.js';

type Queryable = Pick<Db, 'query'> | PoolClient;

export type AssignmentStatus = 'assigned' | 'out_for_delivery' | 'delivered' | 'failed' | 'cancelled';
export type FailureReason = 'store_closed' | 'retailer_refused' | 'address_issue' | 'payment_not_ready' | 'otp_unavailable' | 'other';

export const DELIVERY_OTP_POLICY = { maxAttempts: 5, maxSends: 5, ttlHours: 12 } as const;

export interface OtpDeps {
  sms: SmsSender;
  pepper: string;
}

interface AssignmentRow {
  id: string;
  order_id: string;
  rider_user_id: string;
  status: AssignmentStatus;
  otp_hash: string | null;
  otp_sent_count: number;
  otp_attempts: number;
  otp_expired: boolean;
}

/** Salted per assignment so a code can never be replayed on another delivery. */
const otpSubject = (assignmentId: string) => `delivery:${assignmentId}`;

/** Locks the order, then its assignment. `riderUserId` hides other riders' stops (they look missing). */
async function lockAssignment(
  client: PoolClient,
  assignmentId: string,
  riderUserId?: string,
): Promise<{ assignment: AssignmentRow; order: OrderRow }> {
  const { rows } = await client.query<{ order_id: string }>(
    'SELECT order_id FROM delivery_assignments WHERE id = $1 AND ($2::uuid IS NULL OR rider_user_id = $2)',
    [assignmentId, riderUserId ?? null],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Delivery not found');
  const order = await lockOrder(client, rows[0].order_id);
  const { rows: locked } = await client.query<AssignmentRow>(
    `SELECT id, order_id, rider_user_id, status, otp_hash, otp_sent_count, otp_attempts,
            coalesce(otp_expires_at <= now(), true) AS otp_expired
     FROM delivery_assignments WHERE id = $1 FOR UPDATE`,
    [assignmentId],
  );
  return { assignment: locked[0]!, order };
}

async function sendNewOtp(client: PoolClient, deps: OtpDeps, assignmentId: string, order: OrderRow): Promise<void> {
  const { rows } = await client.query<{ phone: string }>(
    `SELECT u.phone FROM retailer_accounts a JOIN users u ON u.id = a.owner_user_id WHERE a.id = $1`,
    [order.retailer_account_id],
  );
  const code = generateOtpCode();
  await client.query(
    `UPDATE delivery_assignments
     SET otp_hash = $2, otp_attempts = 0, otp_sent_count = otp_sent_count + 1,
         otp_expires_at = now() + make_interval(hours => $3), updated_at = now()
     WHERE id = $1`,
    [assignmentId, hashOtp(deps.pepper, otpSubject(assignmentId), code), DELIVERY_OTP_POLICY.ttlHours],
  );
  // Last step, so a failed send rolls the new code back.
  await deps.sms.sendDeliveryOtp(rows[0]!.phone, order.order_number, code);
}

export async function assignRider(client: PoolClient, orderId: string, riderUserId: string, actor: string) {
  const order = await lockOrder(client, orderId);
  if (order.status !== 'ready_for_dispatch') {
    throw new AppError('CONFLICT', `Order ${order.order_number} is ${order.status.replaceAll('_', ' ')}, not ready for dispatch`);
  }
  const { rows } = await client.query(
    `SELECT 1 FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'rider'
     WHERE u.id = $1 AND u.status = 'active'`,
    [riderUserId],
  );
  if (!rows[0]) throw new AppError('BAD_REQUEST', 'That user is not an active rider');
  const { rows: created } = await client.query<{ id: string }>(
    'INSERT INTO delivery_assignments (order_id, rider_user_id, assigned_by) VALUES ($1, $2, $3) RETURNING id',
    [order.id, riderUserId, actor],
  );
  await setStatus(client, order, 'assigned_to_rider', actor, null);
  return { order, assignmentId: created[0]!.id };
}

/** Takes a stop off a rider (e.g. breakdown); the order goes back to the dispatch queue. */
export async function cancelAssignment(client: PoolClient, assignmentId: string, actor: string, reason: string) {
  const { assignment, order } = await lockAssignment(client, assignmentId);
  if (assignment.status !== 'assigned' && assignment.status !== 'out_for_delivery') {
    throw new AppError('CONFLICT', `Delivery is ${assignment.status.replaceAll('_', ' ')}`);
  }
  await client.query(
    `UPDATE delivery_assignments SET status = 'cancelled', cancel_reason = $2, otp_hash = NULL, updated_at = now() WHERE id = $1`,
    [assignment.id, reason],
  );
  await setStatus(client, order, 'ready_for_dispatch', actor, 'Delivery reassigned');
  return { assignment, order };
}

/** Rider leaves with the stop. The retailer gets a fresh delivery code by SMS. */
export async function startDelivery(client: PoolClient, deps: OtpDeps, assignmentId: string, riderUserId: string) {
  const { assignment, order } = await lockAssignment(client, assignmentId, riderUserId);
  if (assignment.status !== 'assigned') throw new AppError('CONFLICT', `Delivery is ${assignment.status.replaceAll('_', ' ')}`);
  await client.query(
    "UPDATE delivery_assignments SET status = 'out_for_delivery', started_at = now(), updated_at = now() WHERE id = $1",
    [assignment.id],
  );
  await setStatus(client, order, 'out_for_delivery', riderUserId, null);
  await sendNewOtp(client, deps, assignment.id, order);
  return { assignment, order };
}

/** The retailer asks for the code again (lost SMS, or locked after wrong tries). */
export async function resendDeliveryOtp(client: PoolClient, deps: OtpDeps, orderId: string, accountId: string) {
  await lockOrder(client, orderId, accountId);
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM delivery_assignments WHERE order_id = $1 AND status = 'out_for_delivery'",
    [orderId],
  );
  if (!rows[0]) throw new AppError('CONFLICT', 'This order is not out for delivery');
  const { assignment, order } = await lockAssignment(client, rows[0].id);
  if (assignment.otp_sent_count >= DELIVERY_OTP_POLICY.maxSends) {
    throw new AppError('RATE_LIMITED', 'Too many codes sent for this delivery. Please call Taneja support.');
  }
  await sendNewOtp(client, deps, assignment.id, order);
}

export interface CodInput {
  method: 'cash' | 'upi';
  amountPaise: number;
  upiReference?: string;
}

/**
 * Proof of delivery: the retailer's SMS code, plus for COD the amount the rider took. Both are
 * recorded together so there is never a delivered order without its collection, or the reverse.
 * A wrong code is counted even though the request fails. The rider cannot change the order total;
 * a short or excess collection is recorded as a discrepancy for finance and the order stays COD due.
 */
export async function confirmDelivery(
  db: Db,
  pepper: string,
  assignmentId: string,
  riderUserId: string,
  input: { otp: string; cod?: CodInput },
) {
  const result = await withTransaction(db, async (client) => {
    const { assignment, order } = await lockAssignment(client, assignmentId, riderUserId);
    if (assignment.status !== 'out_for_delivery') {
      throw new AppError('CONFLICT', `Delivery is ${assignment.status.replaceAll('_', ' ')}`);
    }
    if (assignment.otp_attempts >= DELIVERY_OTP_POLICY.maxAttempts) {
      throw new AppError('OTP_TOO_MANY_ATTEMPTS', 'Too many wrong codes. Ask the retailer to request a new one.');
    }
    if (assignment.otp_expired || !assignment.otp_hash) {
      throw new AppError('OTP_EXPIRED', 'The delivery code has expired. Ask the retailer to request a new one.');
    }
    if (!safeEqualHex(assignment.otp_hash, hashOtp(pepper, otpSubject(assignment.id), input.otp))) {
      await client.query('UPDATE delivery_assignments SET otp_attempts = otp_attempts + 1, updated_at = now() WHERE id = $1', [
        assignment.id,
      ]);
      // Commit the attempt count, then report the failure outside the transaction.
      return { wrongCode: true as const, attemptsLeft: DELIVERY_OTP_POLICY.maxAttempts - assignment.otp_attempts - 1 };
    }

    const codDue = order.payment_method === 'cod' && order.payment_status === 'cod_due';
    if (codDue && !input.cod) throw new AppError('BAD_REQUEST', 'Record the COD amount collected');
    if (!codDue && input.cod) throw new AppError('BAD_REQUEST', 'Nothing is due on delivery for this order');
    let collection: { expectedPaise: number; collectedPaise: number; matches: boolean } | null = null;
    if (codDue && input.cod) {
      if (input.cod.method === 'upi' && !input.cod.upiReference) {
        throw new AppError('BAD_REQUEST', 'Enter the UPI reference shown on the retailer’s phone');
      }
      const { rows } = await client.query<{ payable_paise: string }>('SELECT payable_paise FROM orders WHERE id = $1', [order.id]);
      const expectedPaise = Number(rows[0]!.payable_paise);
      const matches = input.cod.amountPaise === expectedPaise;
      await client.query(
        `INSERT INTO cod_collections (order_id, assignment_id, rider_user_id, method, expected_paise, collected_paise, upi_reference, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [order.id, assignment.id, riderUserId, input.cod.method, expectedPaise, input.cod.amountPaise,
         input.cod.method === 'upi' ? input.cod.upiReference : null, matches ? 'collected' : 'discrepancy'],
      );
      collection = { expectedPaise, collectedPaise: input.cod.amountPaise, matches };
    }

    await client.query(
      "UPDATE delivery_assignments SET status = 'delivered', delivered_at = now(), otp_hash = NULL, updated_at = now() WHERE id = $1",
      [assignment.id],
    );
    await setStatus(client, order, 'delivered', riderUserId, 'Delivery code confirmed');
    if (collection?.matches) {
      await client.query("UPDATE orders SET payment_status = 'cod_collected', updated_at = now() WHERE id = $1", [order.id]);
      await client.query(
        `INSERT INTO order_events (order_id, kind, from_value, to_value, actor_user_id, note)
         VALUES ($1, 'payment', $2, 'cod_collected', $3, $4)`,
        [order.id, order.payment_status, riderUserId, `Collected by ${input.cod!.method}`],
      );
    }
    return { wrongCode: false as const, assignment, order, collection };
  });
  if (result.wrongCode) {
    throw new AppError('OTP_INVALID', 'That code is not right', { attemptsLeft: result.attemptsLeft });
  }
  return result;
}

export async function failDelivery(
  client: PoolClient,
  assignmentId: string,
  riderUserId: string,
  input: { reason: FailureReason; note?: string },
) {
  const { assignment, order } = await lockAssignment(client, assignmentId, riderUserId);
  if (assignment.status !== 'assigned' && assignment.status !== 'out_for_delivery') {
    throw new AppError('CONFLICT', `Delivery is ${assignment.status.replaceAll('_', ' ')}`);
  }
  await client.query(
    `UPDATE delivery_assignments SET status = 'failed', failure_reason = $2, failure_note = $3, failed_at = now(), otp_hash = NULL,
            updated_at = now()
     WHERE id = $1`,
    [assignment.id, input.reason, input.note ?? null],
  );
  await setStatus(client, order, 'delivery_failed', riderUserId, `Delivery attempt failed: ${input.reason.replaceAll('_', ' ')}`);
  return { assignment, order };
}

/** After a failed attempt the goods are back at the warehouse; dispatch can send them out again. */
export async function redispatch(client: PoolClient, orderId: string, actor: string, reason: string) {
  const order = await lockOrder(client, orderId);
  if (order.status !== 'delivery_failed') throw new AppError('CONFLICT', `Order is ${order.status.replaceAll('_', ' ')}`);
  await setStatus(client, order, 'ready_for_dispatch', actor, reason);
  return order;
}

const ASSIGNMENT_COLUMNS = `
  d.id, d.status, d.order_id AS "orderId", o.order_number AS "orderNumber", o.status AS "orderStatus",
  a.business_name AS "businessName", o.delivery_address AS "deliveryAddress", u.phone AS "retailerPhone",
  o.payment_method AS "paymentMethod",
  CASE WHEN o.payment_method = 'cod' AND o.payment_status = 'cod_due' THEN o.payable_paise::int ELSE 0 END AS "collectPaise",
  t.package_count AS "packageCount", d.assigned_at AS "assignedAt", d.started_at AS "startedAt",
  d.delivered_at AS "deliveredAt", d.failed_at AS "failedAt", d.failure_reason AS "failureReason"`;

const ASSIGNMENT_JOINS = `
  FROM delivery_assignments d
  JOIN orders o ON o.id = d.order_id
  JOIN retailer_accounts a ON a.id = o.retailer_account_id
  JOIN users u ON u.id = a.owner_user_id
  LEFT JOIN warehouse_tasks t ON t.order_id = o.id`;

/** A rider's live stops: where to go, whom to call and what to collect. No line prices. */
export async function listRiderAssignments(db: Queryable, riderUserId: string) {
  const { rows } = await db.query(
    `SELECT ${ASSIGNMENT_COLUMNS},
            ${DELIVERY_OTP_POLICY.maxAttempts} - d.otp_attempts AS "otpAttemptsLeft",
            (SELECT coalesce(json_agg(json_build_object('name', i.name, 'packSize', i.pack_size, 'quantity', i.quantity) ORDER BY i.name), '[]')
             FROM order_items i WHERE i.order_id = o.id) AS items
     ${ASSIGNMENT_JOINS}
     WHERE d.rider_user_id = $1 AND d.status IN ('assigned', 'out_for_delivery')
     ORDER BY d.assigned_at`,
    [riderUserId],
  );
  return rows;
}

export async function listAssignments(db: Queryable, filter: { status?: AssignmentStatus; limit: number; offset: number }) {
  const { rows } = await db.query(
    `SELECT ${ASSIGNMENT_COLUMNS}, d.rider_user_id AS "riderUserId", r.name AS "riderName", d.failure_note AS "failureNote",
            d.cancel_reason AS "cancelReason"
     ${ASSIGNMENT_JOINS}
     JOIN users r ON r.id = d.rider_user_id
     WHERE ($1::text IS NULL OR d.status = $1)
     ORDER BY d.assigned_at DESC
     LIMIT $2 OFFSET $3`,
    [filter.status ?? null, filter.limit, filter.offset],
  );
  return rows;
}

export async function listCodCollections(db: Queryable, filter: { status?: string; limit: number; offset: number }) {
  const { rows } = await db.query(
    `SELECT c.id, c.order_id AS "orderId", o.order_number AS "orderNumber", c.rider_user_id AS "riderUserId", r.name AS "riderName",
            c.method, c.expected_paise::int AS "expectedPaise", c.collected_paise::int AS "collectedPaise",
            c.upi_reference AS "upiReference", c.collected_at AS "collectedAt", c.status,
            c.handed_over_paise::int AS "handedOverPaise", c.reconciled_by AS "reconciledBy", c.reconciled_at AS "reconciledAt",
            c.reconcile_note AS "reconcileNote"
     FROM cod_collections c JOIN orders o ON o.id = c.order_id JOIN users r ON r.id = c.rider_user_id
     WHERE ($1::text IS NULL OR c.status = $1)
     ORDER BY c.collected_at
     LIMIT $2 OFFSET $3`,
    [filter.status ?? null, filter.limit, filter.offset],
  );
  return rows;
}

/**
 * Finance records what the rider handed over. Anything short of the order's payable amount stays a
 * discrepancy, with a note, until it is settled.
 */
export async function reconcileCod(
  client: PoolClient,
  collectionId: string,
  actor: string,
  input: { handedOverPaise: number; note?: string },
) {
  const { rows } = await client.query<{ id: string; status: string; expected: string; collected: string; order_id: string }>(
    `SELECT id, status, expected_paise AS expected, collected_paise AS collected, order_id
     FROM cod_collections WHERE id = $1 FOR UPDATE`,
    [collectionId],
  );
  const c = rows[0];
  if (!c) throw new AppError('NOT_FOUND', 'Collection not found');
  if (c.status === 'reconciled') throw new AppError('CONFLICT', 'Already reconciled');
  const balanced = input.handedOverPaise === Number(c.collected) && Number(c.collected) === Number(c.expected);
  if (!balanced && !input.note) {
    throw new AppError('BAD_REQUEST', 'Explain the difference in a note', {
      expectedPaise: Number(c.expected),
      collectedPaise: Number(c.collected),
      handedOverPaise: input.handedOverPaise,
    });
  }
  const status = balanced ? 'reconciled' : 'discrepancy';
  await client.query(
    `UPDATE cod_collections SET status = $2, handed_over_paise = $3, reconciled_by = $4, reconciled_at = now(), reconcile_note = $5
     WHERE id = $1`,
    [c.id, status, input.handedOverPaise, actor, input.note ?? null],
  );
  return { before: c.status, status, orderId: c.order_id };
}
