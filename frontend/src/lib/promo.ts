// frontend/src/lib/promo.ts
// Promo-code / license-key verification for the upgrade modal.
//
// A code is accepted when it matches one of the locally configured codes
// (VITE_PRO_PROMO_CODES, VITE_PRO_PROMO_CODE, VITE_PADDLE_PROMO_CODE) or an
// active row in the Supabase `license_keys` table.
//
// Supabase is optional here: when the project is not configured — or the
// `license_keys` table has not been created yet — the lookup degrades to the
// configured list instead of throwing, so a missing table can never break the
// web checkout or crash the upgrade modal.
//
// NOTE: a client-side lookup can only be as private as its RLS policies. If the
// `license_keys` table is enabled in Supabase, keep it readable through a
// policy/edge function that returns a boolean for a single submitted code
// (rather than exposing the whole table to the anon key), otherwise the codes
// could be enumerated by anyone holding the public client key.

import { LOCAL_PRO_ACCESS_KEY } from '../store/auth-context';
import { supabase } from './supabase';

/** localStorage flag set whenever a code (or checkout) grants Pro on a device. */
export const PROMO_ACCESS_STORAGE_KEY = LOCAL_PRO_ACCESS_KEY;

export type PromoResult = 'accepted' | 'invalid';

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Codes shipped via env: comma-separated list plus the two legacy single vars. */
function readConfiguredCodes(): string[] {
  const configured = [
    import.meta.env.VITE_PRO_PROMO_CODES as string | undefined,
    import.meta.env.VITE_PRO_PROMO_CODE as string | undefined,
    import.meta.env.VITE_PADDLE_PROMO_CODE as string | undefined,
  ];
  return configured
    .flatMap((value) => (typeof value === 'string' ? value.split(',') : []))
    .map(normalizeCode)
    .filter(Boolean);
}

/**
 * Looks the code up in `license_keys`.
 * Returns true/false when Supabase answers, or null when it cannot be consulted
 * (client not configured, table missing, network error) — callers treat null as
 * "unknown", never as "invalid".
 */
async function lookupSupabaseLicenseKey(code: string): Promise<boolean | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('license_keys')
      .select('*')
      .ilike('code', code)
      .limit(1);

    if (error) {
      if (import.meta.env.DEV) {
        console.warn('[promo] license_keys lookup failed:', error.message);
      }
      return null;
    }
    if (!Array.isArray(data) || data.length === 0) return null;

    const row = data[0] as Record<string, unknown>;
    const revoked = row.revoked === true || row.redeemed === true;
    const inactive = row.is_active === false || row.active === false;
    if (revoked || inactive) return false;

    if (typeof row.expires_at === 'string') {
      const expiry = Date.parse(row.expires_at);
      if (Number.isFinite(expiry) && expiry < Date.now()) return false;
    }
    return true;
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('[promo] license_keys lookup threw:', error);
    }
    return null;
  }
}

/** Grants the local device entitlement that `readStoredProStatus` reads back. */
export function grantLocalProAccess(): void {
  try {
    localStorage.setItem(PROMO_ACCESS_STORAGE_KEY, 'true');
  } catch {
    // localStorage can be unavailable (private mode / restricted file://).
  }
}

/** Verifies a promo code. Never throws. */
export async function verifyPromoCode(code: string): Promise<PromoResult> {
  const normalized = normalizeCode(code);
  if (!normalized) return 'invalid';

  if (readConfiguredCodes().includes(normalized)) return 'accepted';

  const fromSupabase = await lookupSupabaseLicenseKey(normalized);
  return fromSupabase === true ? 'accepted' : 'invalid';
}
