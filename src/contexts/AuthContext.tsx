import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

interface Profile {
  id: string;
  organization_id: string | null;
  role: string;
  full_name: string | null;
}

interface AuthContextValue {
  session: Session | null;
  profile: Profile | null;
  isPlatformAdmin: boolean;
  loading: boolean;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  session: null,
  profile: null,
  isPlatformAdmin: false,
  loading: true,
  refreshProfile: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  async function loadProfile(userId: string) {
    const [{ data }, { data: adminRow }] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, organization_id, role, full_name")
        .eq("id", userId)
        .maybeSingle(),
      supabase.from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle(),
    ]);
    setProfile(data);
    setIsPlatformAdmin(Boolean(adminRow));
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      if (data.session) await loadProfile(data.session.user.id);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      setSession(newSession);
      if (newSession) await loadProfile(newSession.user.id);
      else setProfile(null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  return (
    <AuthContext.Provider
      value={{
        session,
        profile,
        isPlatformAdmin,
        loading,
        refreshProfile: async () => {
          if (session) await loadProfile(session.user.id);
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
