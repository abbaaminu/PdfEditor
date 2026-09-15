// frontend/src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_SUPABASE_URL = 'https://nabxjubdxxqewrqocsbz.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5hYnhqdWJkeHhxZXdycW9jc2J6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3NjAzMzYsImV4cCI6MjEwNDMzNjMzNn0.6s8Iw85vO8pn0Y-KPjpUb8b0OoVO2cYzNXjMxJYLcAQ';

const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || DEFAULT_SUPABASE_URL;
const SUPABASE_ANON_KEY =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ||
  DEFAULT_SUPABASE_ANON_KEY;
const SUPABASE_AUTH_STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

/** Sign out the current user and clear local session state. */
export async function signOutUser(): Promise<void> {
  try {
    if (supabase) {
      await supabase.auth.signOut({ scope: 'local' });
    }
  } finally {
    for (const key of [
      'pdfeditor.pro',
      'pro_unlocked',
      'has_pro_access',
      SUPABASE_AUTH_STORAGE_KEY,
    ]) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Storage can be unavailable in restricted browser contexts.
      }
    }
  }
}

/** Read the signed-in user's Pro entitlement from the profiles table. */
export async function fetchProfileProStatus(userId: string): Promise<boolean | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('is_pro')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data?.is_pro === true;
}

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