// How money, phones and refusals read on the page.
import { ApiError } from '@shop/api-client';

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Dollars as $1,234.50. */
export const money = (dollars: number): string => USD.format(dollars);

/** Ten digits as (555) 010-0000; anything else as given. */
export function phone(digits: string): string {
  const m = /^(\d{3})(\d{3})(\d{4})$/.exec(digits);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : digits;
}

/** A bill number: 1 to 7 digits. */
export const BILL_NO = /^\d{1,7}$/;

/** Typed dollars (a $ and commas allowed, at most 2 decimals) -> whole cents; null when it isn't money. */
export function cents(text: string): number | null {
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** What to tell the admin about a failed request. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 409) return `${e.message}. Showing what is there now.`;
    if (e.status === 401) return 'Signed out: sign in again on the tickets page.';
    return e.message;
  }
  return 'Could not reach the shop server. Check the connection and try again.';
}
