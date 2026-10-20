import { DEFAULT_CHECKOUT_POLICY, paise, type CheckoutPolicy } from '@taneja/domain';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Db } from './db.js';

type Queryable = Pick<Db, 'query'> | PoolClient;

const paiseSchema = z.number().int().nonnegative().transform(paise);

const checkoutPolicySchema = z.object({
  minimumOrderPaise: paiseSchema,
  minimumOrderBasis: z.enum(['subtotal', 'payable']),
  deliveryFeePaise: paiseSchema,
  codLimitPaise: paiseSchema,
  codLimitInclusive: z.boolean(),
  codLimitBasis: z.enum(['payable', 'subtotal']),
});

/** Reads the checkout policy from app_settings, falling back to the documented defaults if the row is missing. */
export async function loadCheckoutPolicy(db: Queryable): Promise<CheckoutPolicy> {
  const { rows } = await db.query<{ value: unknown }>("SELECT value FROM app_settings WHERE key = 'checkout.policy'");
  if (rows.length === 0) return DEFAULT_CHECKOUT_POLICY;
  return checkoutPolicySchema.parse(rows[0]!.value);
}

export async function discountsEnabled(db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ value: unknown }>(
    "SELECT value FROM app_settings WHERE key = 'pricing.discounts_enabled'",
  );
  return rows[0]?.value === true;
}

export async function settingBool(db: Queryable, key: string): Promise<boolean> {
  const { rows } = await db.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0]?.value === true;
}

export async function settingNumber(db: Queryable, key: string, fallback: number): Promise<number> {
  const { rows } = await db.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [key]);
  return typeof rows[0]?.value === 'number' ? rows[0].value : fallback;
}
