/** Indian mobile numbers in E.164 form, e.g. +919876543210. */
export type IndianMobile = string & { readonly __brand: 'IndianMobile' };

/**
 * Normalises common Indian mobile formats ("98765 43210", "09876543210", "+91-98765-43210")
 * to E.164. Returns null for anything that is not a valid Indian mobile number.
 */
export function normalizeIndianMobile(input: string): IndianMobile | null {
  const digits = input.replace(/[\s\-().]/g, '');
  const match = /^(?:\+91|0091|91|0)?([6-9]\d{9})$/.exec(digits);
  return match ? (`+91${match[1]}` as IndianMobile) : null;
}

/** Masks a phone for logs and support screens: +91******3210. */
export function maskPhone(phone: string): string {
  return phone.length > 4 ? `${phone.slice(0, 3)}${'*'.repeat(Math.max(phone.length - 7, 0))}${phone.slice(-4)}` : '****';
}
