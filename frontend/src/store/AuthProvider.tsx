import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FC, ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { fetchProfileProStatus, isSupabaseConfigured, supabase } from '../lib/supabase';
import {
  AuthContext,
  LOCAL_PRO_UNLOCKED_KEY,
  LOCAL_PRO_ACCESS_KEY,
  MAX_FREE_USES,
  PRO_STORAGE_KEY,
  persistProStatus,
  persistUsageCount,
  readStoredProStatus,
  readStoredUsageCount,
} from './auth-context';
import type { AuthStoreValue } from './auth-context';

export const AuthProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isProUser, setIsProUser] = useState<boolean>(readStoredProStatus);
  const [isProLoading, setIsProLoading] = useState(false);
  const [usageCount, setUsageCount] = useState<number>(() => readStoredUsageCount());

  // Latest user id readable from callbacks that must not capture stale state.
  const userIdRef = useRef<string | null>(null);
  // Live mirror so async trial bookkeeping never reads a stale Pro snapshot.
  const isProUserRef = useRef(isProUser);
  useEffect(() => {
    isProUserRef.current = isProUser;
  }, [isProUser]);

  useEffect(() => {
    const client = supabase;
    if (!client) return;

    let disposed = false;
    /** Query the DB for the user's profile to decide Pro status. */
    const fetchProStatus = async (userId: string) => {
      setIsProLoading(true);
      try {
        const isPro = await fetchProfileProStatus(userId);
        if (disposed) return;
        if (isPro === true) persistProStatus(true);
        setIsProUser(isPro === true || readStoredProStatus());
      } catch (error) {
        if (disposed) return;
        console.error('[auth] failed to load profile status:', error);
        setIsProLoading(false);
        return;
      }
      setIsProLoading(false);
    };

    /** Apply a session change and verify the profile entitlement. */
    const applySession = async (nextSession: Session | null) => {
      if (disposed) return;
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      userIdRef.current = nextSession?.user?.id ?? null;
      if (nextSession?.user) {
        await fetchProStatus(nextSession.user.id);
      } else {
        // Signed out: fall back to the locally stored flag (demo/dev mode).
        setIsProLoading(false);
        setIsProUser(readStoredProStatus());
      }
    };

    // Initial session.
    client.auth
      .getSession()
      .then(({ data }) => {
        if (!disposed) void applySession(data.session);
      })
      .catch((err) => {
        console.error('[auth] failed to read session:', err);
      });

    // Listen for sign in / out / token refresh.
    const { data: authListener } = client.auth.onAuthStateChange(
      (_event, nextSession) => {
        // Defer so supabase-js never deadlocks when we call auth APIs.
        window.setTimeout(() => {
          if (!disposed) void applySession(nextSession);
        }, 0);
      }
    );

    // Keep in-memory state in sync with external localStorage changes when no
    // Supabase session is active, and re-query the DB when one is.
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === PRO_STORAGE_KEY ||
        event.key === LOCAL_PRO_UNLOCKED_KEY ||
        event.key === LOCAL_PRO_ACCESS_KEY
      ) {
        const currentUserId = userIdRef.current;
        if (currentUserId) void fetchProStatus(currentUserId);
        else setIsProUser(readStoredProStatus());
      }
    };
    window.addEventListener('storage', handleStorage);
    const handleFocus = () => {
      if (userIdRef.current) void fetchProStatus(userIdRef.current);
    };
    const handlePageShow = () => {
      if (userIdRef.current) void fetchProStatus(userIdRef.current);
    };
    window.addEventListener('focus', handleFocus);
    window.addEventListener('pageshow', handlePageShow);

    return () => {
      disposed = true;
      authListener.subscription.unsubscribe();
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, []);

  const setProUser = useCallback((isPro: boolean) => {
    setIsProUser(isPro);
    persistProStatus(isPro);
  }, []);

  const refreshProStatus = useCallback(async () => {
    const currentUserId = userIdRef.current;
    if (!currentUserId) return false;
    try {
      const isPro = (await fetchProfileProStatus(currentUserId)) === true;
      setIsProUser(isPro);
      persistProStatus(isPro);
      return isPro;
    } catch (error) {
      console.error('[auth] failed to refresh profile status:', error);
      return false;
    }
  }, []);

  /**
   * Records one successful free action. Pro subscribers bypass the trial, so
   * their actions never consume (or overflow) the per-device budget. The count
   * is capped at MAX_FREE_USES and only ever grows — no auto-resets/expiries.
   */
  const incrementUsage = useCallback(() => {
    if (isProUserRef.current) return;
    setUsageCount((current) => {
      const next = Math.min(current + 1, MAX_FREE_USES);
      persistUsageCount(next);
      return next;
    });
  }, []);

  /** Clears the per-device trial counter (dev/test utility, not user-facing). */
  const resetUsage = useCallback(() => {
    if (!import.meta.env.DEV) return;
    setUsageCount(0);
    persistUsageCount(0);
  }, []);

  // Dev-mode helper: expose window.resetTrialUsage so the counter can be
  // cleared from the console during rapid testing.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const devWindow = window as unknown as { resetTrialUsage?: () => void };
    devWindow.resetTrialUsage = resetUsage;
    return () => {
      devWindow.resetTrialUsage = undefined;
    };
  }, [resetUsage]);

  const value = useMemo<AuthStoreValue>(
    () => ({
      user,
      session,
      isProUser,
      isProLoading,
      isSupabaseReady: isSupabaseConfigured,
      setProUser,
      refreshProStatus,
      usageCount,
      remainingUses: Math.max(0, MAX_FREE_USES - usageCount),
      incrementUsage,
      resetUsage,
    }),
    [
      user,
      session,
      isProUser,
      isProLoading,
      usageCount,
      setProUser,
      refreshProStatus,
      incrementUsage,
      resetUsage,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

