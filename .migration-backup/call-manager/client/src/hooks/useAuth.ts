import { useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase.js';
import type { User as AppUser } from '../../../types/index.js';
import { getMe } from '../lib/api.js';

interface AuthState {
  session: Session | null;
  supaUser: User | null;
  profile: AppUser | null;
  loading: boolean;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    session: null,
    supaUser: null,
    profile: null,
    loading: true,
  });

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      const session = data.session;
      let profile: AppUser | null = null;
      if (session) {
        try { profile = await getMe(); } catch { /* ignore */ }
      }
      setState({ session, supaUser: session?.user ?? null, profile, loading: false });
    });

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, session) => {
      let profile: AppUser | null = null;
      if (session) {
        try { profile = await getMe(); } catch { /* ignore */ }
      }
      setState({ session, supaUser: session?.user ?? null, profile, loading: false });
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  return state;
}
