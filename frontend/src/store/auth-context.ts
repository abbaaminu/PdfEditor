import { createContext, useContext } from 'react';
import type { Session, User } from '@supabase/supabase-js';

/**
 * Auth + Pro-subscription store exposed through React context.
 * Consumers read/write it with the `useAuthStore` hook, so components that
 * need it (UpgradeModal, gated tool cards…) stay decoupled from the provider.
 */

export const PRO_STORAGE_KEY = 'pdfeditor.pro';
/** Device entitlement granted by a successful guest checkout or promo code. */
export const LOCAL_PRO_UNLOCKED_KEY = 'pro_unlocked';
/**
 * Device entitlement written by every Pro unlock path (web checkout, desktop
 * hand-off, promo code / license key) and read back on the next launch.
 */
export const LOCAL_PRO_ACCESS_KEY = 'has_pro_access';

/**
 * Per-device free-trial counter. Persisted in localStorage so the 3 free uses
 * survive reloads. It never auto-resets or expires: clearing it requires an
 * explicit dev-mode reset (or is bypassed entirely by a Pro subscription).
 */
export const TRIAL_USAGE_STORAGE_KEY = 'pdf_doc_suite_usage_count';

/** Number of free-trial uses granted once, per device, to non-Pro users. */
export const MAX_FREE_USES = 3;

/** Shown in the UpgradeModal when a non-Pro user hits the 4th attempt. */
export const FREE_TRIAL_LIMIT_MESSAGE =
  "You've reached your limit of 3 free uses on this device. Upgrade to Pro for unlimited access.";

export interface AuthStoreValue {
  /** The currently signed-in Supabase user, or null when signed out. */
  user: User | null;
  /** The active Supabase auth session, or null when signed out. */
  session: Session | null;
  /**
   * True while the Pro status for the current user is being fetched from the
   * `subscriptions` table (avoids flashing a false "locked" UI).
   */
  isProLoading: boolean;
  /** True when a Supabase client could be initialized from env vars. */
  isSupabaseReady: boolean;
  /** True when the user holds an active/trialing subscription (or the local
   *  fallback flag is set while no Supabase session exists). */
  isProUser: boolean;
  /** Optimistically flips Pro state and persists the local fallback flag. */
  setProUser: (isPro: boolean) => void;
  /** Re-checks the signed-in user's profiles.is_pro entitlement. */
  refreshProStatus: () => Promise<boolean>;
  /** Successful free-trial actions completed on this device (0..MAX_FREE_USES). */
  usageCount: number;
  /** Free-trial uses left before the gate locks the app (0 when exhausted). */
  remainingUses: number;
  /** Records one successful free action; a no-op while the user is Pro. */
  incrementUsage: () => void;
  /** Clears the per-device trial counter (dev/testing utility). */
  resetUsage: () => void;
}

export const AuthContext = createContext<AuthStoreValue | null>(null);

export function useAuthStore(): AuthStoreValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuthStore must be used inside an <AuthProvider>.');
  }
  return context;
}

export function readStoredProStatus(): boolean {
  try {
    return (
      localStorage.getItem(PRO_STORAGE_KEY) === 'true' ||
      localStorage.getItem(LOCAL_PRO_UNLOCKED_KEY) === 'true' ||
      localStorage.getItem(LOCAL_PRO_ACCESS_KEY) === 'true'
    );
  } catch {
    return false;
  }
}

export function persistProStatus(isPro: boolean): void {
  try {
    if (isPro) {
      localStorage.setItem(PRO_STORAGE_KEY, 'true');
      localStorage.setItem(LOCAL_PRO_UNLOCKED_KEY, 'true');
      localStorage.setItem(LOCAL_PRO_ACCESS_KEY, 'true');
    } else {
      localStorage.removeItem(PRO_STORAGE_KEY);
      localStorage.removeItem(LOCAL_PRO_UNLOCKED_KEY);
      localStorage.removeItem(LOCAL_PRO_ACCESS_KEY);
    }
  } catch {
    // localStorage may be unavailable (private mode / file:// restrictions).
  }
}

export function readStoredUsageCount(): number {
  try {
    const stored = localStorage.getItem(TRIAL_USAGE_STORAGE_KEY);
    if (stored === null) return 0;
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

export function persistUsageCount(count: number): void {
  try {
    if (count <= 0) {
      localStorage.removeItem(TRIAL_USAGE_STORAGE_KEY);
    } else {
      localStorage.setItem(TRIAL_USAGE_STORAGE_KEY, String(count));
    }
  } catch {
    // localStorage may be unavailable (private mode / file:// restrictions).
  }
}

