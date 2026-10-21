/** Thin client for the Taneja API (staff console). The token lives in localStorage; nothing else sensitive is stored. */

const BASE = import.meta.env.VITE_API_URL ?? '/api';
const TOKEN_KEY = 'taneja.staff.token';

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

/** Fetches a private file (KYC or return evidence) with the session token and returns a local object URL. */
export async function fetchFileUrl(path: string): Promise<string> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, 'FILE_UNAVAILABLE', 'Could not open the file');
  return URL.createObjectURL(await res.blob());
}

export type Role = { role: string; retailerAccountId?: string | null };
export type Me = { user: { id: string; phone: string; name: string | null }; roles: Role[] };

export interface OrderSummary {
  id: string;
  orderNumber: string;
  businessName: string;
  status: string;
  paymentMethod: 'prepaid' | 'cod';
  paymentStatus: string;
  payablePaise: number;
  placedAt: string;
  itemCount: number;
}

export interface OrderDetail extends OrderSummary {
  subtotalPaise: number;
  taxPaise: number;
  deliveryFeePaise: number;
  deliveryAddress: Record<string, string | number | null>;
  items: { productId: string; sku: string; name: string; packSize: string | null; quantity: number; totalPaise: number }[];
  events: { kind: string; from: string | null; to: string; note: string | null; at: string }[];
  allocations: { productId: string; batchNumber: string; expiryDate: string; location: string | null; quantity: number; releasedAt: string | null }[];
  invoice: { invoiceNumber: string; amountPaise: number } | null;
}

export interface PickLine {
  id: string;
  sku: string;
  name: string;
  packSize: string | null;
  batchNumber: string;
  expiryDate: string;
  location: string | null;
  expectedQty: number;
  pickedQty: number | null;
  shortReason: string | null;
  shortResolvedAt: string | null;
  confirmedAt: string | null;
}

export interface Task {
  id: string;
  status: 'open' | 'picking' | 'short_pick' | 'picked' | 'packed' | 'cancelled';
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  businessName: string;
  lineCount?: number;
  packageCount?: number | null;
  lines?: PickLine[];
}

export interface Stop {
  id: string;
  status: 'assigned' | 'out_for_delivery';
  orderNumber: string;
  businessName: string;
  deliveryAddress: Record<string, string | number | null>;
  retailerPhone: string;
  paymentMethod: 'prepaid' | 'cod';
  collectPaise: number;
  packageCount: number | null;
  otpAttemptsLeft: number;
  items: { name: string; packSize: string | null; quantity: number }[];
}
