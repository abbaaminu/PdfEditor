// frontend/src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://nabxjubdxxqewrqocsbz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5hYnhqdWJkeHhxZXdycW9jc2J6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3NjAzMzYsImV4cCI6MjEwNDMzMzMzNn0.6s8Iw85vO8pn0Y-KPjpUb8b0OoVO2cYzNXjMxJYLcAQ';

export const isSupabaseConfigured = true;

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/** Sign out the current user and clear local session state. */
export async function signOutUser(): Promise<void> {
  if (supabase) {
    await supabase.auth.signOut();
  }
  localStorage.clear();
}

/** Read the signed-in user's Pro entitlement from the profiles table. */
export async function fetchProfileProStatus(userId: string): Promise<boolean | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('is_pro')
    .eq('id', userId)
    .single();
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