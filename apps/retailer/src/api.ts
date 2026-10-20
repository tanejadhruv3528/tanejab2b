/** Thin client for the Taneja API. The token lives in localStorage; nothing else sensitive is stored. */

const BASE = import.meta.env.VITE_API_URL ?? '/api';
const TOKEN_KEY = 'taneja.token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode: the session simply won't survive a reload.
  }
}

export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { contentType?: string; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...opts.headers };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof Blob) {
    payload = body;
    headers['content-type'] = opts.contentType ?? body.type;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.error ?? {};
    if (res.status === 401) setToken(null);
    throw new ApiError(res.status, e.code ?? 'UNKNOWN', e.message ?? 'Request failed', e.details);
  }
  return json as T;
}

export type Role = { role: string; retailerAccountId?: string | null };
export type Me = { user: { id: string; phone: string; name: string | null; language: 'en' | 'hi' }; roles: Role[] };

export type Availability = 'in_stock' | 'low_stock' | 'out_of_stock' | 'restricted' | 'discontinued';

export interface Product {
  id: string;
  sku: string;
  name: string;
  genericName: string | null;
  manufacturer: string;
  strength: string | null;
  packSize: string | null;
  mrpPaise: number | null;
  coldChain: boolean;
  schedule: string | null;
  availability: Availability;
  stockStale: boolean;
}

export type LineIssue =
  | 'DISCONTINUED'
  | 'RESTRICTED'
  | 'COLD_CHAIN_NOT_ENABLED'
  | 'OUT_OF_STOCK'
  | 'INSUFFICIENT_STOCK'
  | 'PRICE_MISSING'
  | 'TAX_RATE_MISSING';

export interface CartLine {
  productId: string;
  sku: string;
  name: string;
  manufacturer: string;
  packSize: string | null;
  quantity: number;
  issues: LineIssue[];
  availableQuantity?: number;
  stockStale: boolean;
  pricing: { valuePaise: number; discountPaise: number; taxPaise: number; totalPaise: number; gstRateBps: number } | null;
}

export interface Cart {
  lines: CartLine[];
  subtotalPaise: number;
  discountPaise: number;
  taxPaise: number;
  canCheckout: boolean;
  checkout: {
    deliveryFeePaise: number;
    payablePaise: number;
    canOrder: boolean;
    orderBlockers: string[];
    codEligible: boolean;
    codBlockers: string[];
    paymentMethods: ('prepaid' | 'cod')[];
  };
}

export interface Onboarding {
  account: {
    businessName: string | null;
    ownerName: string | null;
    email: string | null;
    gstin: string | null;
    status: string;
  } | null;
  store?: {
    addressLine1: string;
    addressLine2: string | null;
    landmark: string | null;
    city: string;
    district: string;
    state: string;
    postalCode: string;
    latitude: number;
    longitude: number;
  } | null;
  license?: { type: string; number: string; validUntil: string } | null;
  documents?: { id: string; kind: string }[];
  latestDecision?: { status: string; reason: string | null } | null;
  gaps?: string[];
}

export interface OrderSummary {
  id: string;
  orderNumber: string;
  status: string;
  paymentMethod: 'prepaid' | 'cod';
  paymentStatus: string;
  payablePaise: number;
  placedAt: string;
  itemCount?: number;
}

export interface Order extends OrderSummary {
  subtotalPaise: number;
  discountPaise: number;
  taxPaise: number;
  deliveryFeePaise: number;
  paymentDueBy: string | null;
  items: { productId: string; sku: string; name: string; packSize: string | null; quantity: number; totalPaise: number }[];
  events: { kind: 'status' | 'payment'; from: string | null; to: string; note: string | null; at: string }[];
}

/** One key per checkout attempt, reused on retry so a lost response never creates a second order. */
export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
