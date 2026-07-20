"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { authApi, type UserInfo } from "@/lib/api";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  sessionToken: string | null;
  user: string | null;
  login: (token: string, user: UserInfo) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const SESSION_KEY = "bili_session";
const USER_KEY = "bili_user";
const CHAT_SESSION_KEY = "bili_chat_session";

function resolveDisplayName(user: UserInfo): string {
  return user.uname || user.nickname || "用户";
}

/**
 * Single source of truth for client-side auth state.
 *
 * Token stays in localStorage (Bearer token, injected by api.ts getAuthHeaders).
 * This provider only mirrors it into React state so guarded routes and the home
 * page can react to login/logout/401 uniformly.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [user, setUser] = useState<string | null>(null);

  // Initialize from localStorage on mount. Client-only to avoid hydration mismatch;
  // initial render is "loading" so protected content never flashes.
  useEffect(() => {
    const token = localStorage.getItem(SESSION_KEY);
    if (token) {
      setSessionToken(token);
      setUser(localStorage.getItem(USER_KEY) || "用户");
      setStatus("authenticated");
    } else {
      setStatus("unauthenticated");
    }
  }, []);

  // React to 401 dispatched by api.ts: drop local auth and return to home
  // (home hero is the login entry). Keeps every API surface consistent.
  useEffect(() => {
    const onUnauthorized = () => {
      setSessionToken(null);
      setUser(null);
      setStatus("unauthenticated");
      router.replace("/");
    };
    window.addEventListener("auth:unauthorized", onUnauthorized);
    return () => window.removeEventListener("auth:unauthorized", onUnauthorized);
  }, [router]);

  const login = useCallback((token: string, userInfo: UserInfo) => {
    const name = resolveDisplayName(userInfo);
    localStorage.setItem(SESSION_KEY, token);
    localStorage.setItem(USER_KEY, name);
    setSessionToken(token);
    setUser(name);
    setStatus("authenticated");
  }, []);

  const logout = useCallback(async () => {
    if (sessionToken) {
      try {
        await authApi.logoutCurrent(sessionToken);
      } catch {
        // Best-effort: network may be gone; still clear locally.
      }
    }
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(CHAT_SESSION_KEY);
    setSessionToken(null);
    setUser(null);
    setStatus("unauthenticated");
  }, [sessionToken]);

  return (
    <AuthContext.Provider value={{ status, sessionToken, user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
