// frontend/src/lib/supabase.ts
// Central Supabase client. Reads the public project config from Vite env vars.
//
//   VITE_SUPABASE_URL      -> https://<project-ref>.supabase.co
//   VITE_SUPABASE_ANON_KEY -> anon/public API key
//
// If the variables are missing (e.g. local dev without a linked project) the
// module exports a null client plus isSupabaseConfigured=false so the rest of
// the app can degrade gracefully instead of crashing at import time.

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl as string, supabaseAnonKey as string)
  : null;

/** A subscription is "Pro" while it is active or on trial. */
export function isProStatus(status: string | null | undefined): boolean {
  return status === 'active' || status === 'trialing';
}

/** Shape of the `subscriptions` row consumed by the auth store. */
export interface SubscriptionStatus {
  user_id: string;
  status: string | null;
  paddle_subscription_id: string | null;
}
