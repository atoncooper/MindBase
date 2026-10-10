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
import { authApi, userApi, type UserInfo } from "@/lib/api";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  sessionToken: string | null;
  user: string | null;
  /** 头像 URL（资料修改后自动同步；无头像为 null，调用方显示首字母） */
  avatar: string | null;
  /** 精确 uid 字符串（int64 超过 Number.MAX_SAFE_INTEGER，禁止转 number） */
  uid: string | null;
  login: (token: string, user: UserInfo) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const SESSION_KEY = "bili_session";
const USER_KEY = "bili_user";
const UID_KEY = "bili_uid";
const AVATAR_KEY = "bili_avatar";
const CHAT_SESSION_KEY = "bili_chat_session";

function resolveDisplayName(user: UserInfo): string {
  return user.uname || user.nickname || "用户";
}

/**
 * Single source of truth for client-side auth state.
 *
 * Token stays in localStorage (Bearer token, injected by api.ts getAuthHeaders).
 * This provider only mirrors it into React state so guarded routes and the home
 * page can react to login/logout/401 uniformly. Also persists the uid so
 * per-user client caches (e.g. wallpaper) can key off it.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [user, setUser] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [uid, setUid] = useState<string | null>(null);

  // Initialize from localStorage on mount. Must run in an effect (not a lazy
  // useState initializer) so the server and client first-render both produce
  // "loading" — reading localStorage during render would cause a hydration
  // mismatch. This is the documented SSR-safe escape hatch.
  useEffect(() => {
    const token = localStorage.getItem(SESSION_KEY);
    if (token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time bootstrap from localStorage, no cascading renders after first run
      setSessionToken(token);
      setUser(localStorage.getItem(USER_KEY) || "用户");
      setAvatar(localStorage.getItem(AVATAR_KEY));
      const storedUid = localStorage.getItem(UID_KEY);
      if (storedUid) setUid(storedUid);
      setStatus("authenticated");
    } else {
      setStatus("unauthenticated");
    }
  }, []);

  // 登录态下拉取最新资料：让个人中心里改过的昵称/头像在全站（含首页导航）
  // 立即生效，而不是等下一次登录。uid 以本地存储为准（服务器 JSON number
  // 会丢精度）。
  useEffect(() => {
    if (status !== "authenticated" || !sessionToken) return;
    let cancelled = false;
    userApi
      .getProfile()
      .then((p) => {
        if (cancelled) return;
        const name = p.nickname || "用户";
        setUser(name);
        localStorage.setItem(USER_KEY, name);
        if (p.avatar) {
          setAvatar(p.avatar);
          localStorage.setItem(AVATAR_KEY, p.avatar);
        }
      })
      .catch(() => {
        /* 静默：资料拉取失败不影响已登录态 */
      });
    return () => {
      cancelled = true;
    };
  }, [status, sessionToken]);

  // React to 401 dispatched by api.ts: drop local auth and return to home
  // (home hero is the login entry). Keeps every API surface consistent.
  useEffect(() => {
    const onUnauthorized = () => {
      setSessionToken(null);
      setUser(null);
      setAvatar(null);
      setUid(null);
      setStatus("unauthenticated");
      router.replace("/");
    };
    window.addEventListener("auth:unauthorized", onUnauthorized);
    return () => window.removeEventListener("auth:unauthorized", onUnauthorized);
  }, [router]);

  const login = useCallback((token: string, userInfo: UserInfo) => {
    const name = resolveDisplayName(userInfo);
    const resolvedUid = userInfo.uid ?? userInfo.mid ?? null;
    const avatar = userInfo.avatar ?? userInfo.face ?? null;
    localStorage.setItem(SESSION_KEY, token);
    localStorage.setItem(USER_KEY, name);
    if (resolvedUid != null) localStorage.setItem(UID_KEY, String(resolvedUid));
    if (avatar) localStorage.setItem(AVATAR_KEY, avatar);
    setSessionToken(token);
    setUser(name);
    setAvatar(avatar);
    setUid(resolvedUid != null ? String(resolvedUid) : null);
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
    localStorage.removeItem(UID_KEY);
    localStorage.removeItem(AVATAR_KEY);
    localStorage.removeItem(CHAT_SESSION_KEY);
    setSessionToken(null);
    setUser(null);
    setAvatar(null);
    setUid(null);
    setStatus("unauthenticated");
  }, [sessionToken]);

  return (
    <AuthContext.Provider value={{ status, sessionToken, user, avatar, uid, login, logout }}>
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
