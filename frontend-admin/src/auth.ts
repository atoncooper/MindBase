import { useSyncExternalStore } from "react";
import { api } from "./api/client";
import type { MeInfo } from "./api/types";

export type AuthStatus = "loading" | "guest" | "authed";

export interface AuthState {
  status: AuthStatus;
  me: MeInfo | null;
}

let state: AuthState = { status: "loading", me: null };
const listeners = new Set<() => void>();

function setState(next: AuthState): void {
  state = next;
  listeners.forEach((l) => l());
}

export function setMe(me: MeInfo | null): void {
  setState({ status: me ? "authed" : "guest", me });
}

/** 启动时用 HttpOnly cookie 会话恢复登录态（GET /api/me） */
export async function refreshMe(): Promise<void> {
  try {
    const me = await api.me();
    setState({ status: "authed", me });
  } catch {
    setState({ status: "guest", me: null });
  }
}

export function useAuth(): AuthState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => state,
  );
}
