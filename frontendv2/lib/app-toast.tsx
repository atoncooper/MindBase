"use client";

/**
 * Global toast host — the app-wide popup for auth / gateway-level errors.
 *
 * Non-React code (lib/api/client.ts, lib/api/chat.ts) cannot call hooks, so
 * this exposes an event-driven emitter: `emitAppToast(kind, message)` dispatch
 * es a window event that the provider (mounted once in app/layout.tsx) listens
 * for and renders. The mind-map editor keeps its own local ToastProvider until
 * this global host covers its use-cases (see toast.tsx TODO there).
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

export type AppToastKind = "success" | "error" | "warning" | "info";

interface AppToastItem {
    id: number;
    kind: AppToastKind;
    message: string;
}

const APP_TOAST_EVENT = "app:toast";

export function emitAppToast(kind: AppToastKind, message: string): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(APP_TOAST_EVENT, { detail: { kind, message } }));
}

const KIND_ICON = {
    success: CheckCircle2,
    error: XCircle,
    warning: AlertTriangle,
    info: Info,
} as const;

const KIND_COLOR = {
    success: "text-success",
    error: "text-danger",
    warning: "text-warning",
    info: "text-accent",
} as const;

const DEFAULT_DURATION: Record<AppToastKind, number> = {
    success: 2600,
    info: 3200,
    warning: 4200,
    error: 5000,
};

interface AppToastContextValue {
    show: (kind: AppToastKind, message: string) => void;
}

const AppToastContext = createContext<AppToastContextValue | null>(null);

/** Hook form for React components that prefer context over the emitter. */
export function useAppToast(): AppToastContextValue {
    const ctx = useContext(AppToastContext);
    if (!ctx) throw new Error("useAppToast must be used within AppToastProvider");
    return ctx;
}

export function AppToastProvider({ children }: { children: React.ReactNode }) {
    const [items, setItems] = useState<AppToastItem[]>([]);
    const [mounted, setMounted] = useState(false);
    const nextId = useRef(1);

    useEffect(() => setMounted(true), []);

    const show = useCallback((kind: AppToastKind, message: string) => {
        const id = nextId.current++;
        setItems((prev) => [...prev.slice(-3), { id, kind, message }]);
        window.setTimeout(() => {
            setItems((prev) => prev.filter((t) => t.id !== id));
        }, DEFAULT_DURATION[kind]);
    }, []);

    useEffect(() => {
        const onToast = (event: Event): void => {
            const detail = (event as CustomEvent<{ kind: AppToastKind; message: string }>).detail;
            if (detail?.message) show(detail.kind, detail.message);
        };
        window.addEventListener(APP_TOAST_EVENT, onToast);
        return () => window.removeEventListener(APP_TOAST_EVENT, onToast);
    }, [show]);

    return (
        <AppToastContext.Provider value={{ show }}>
            {children}
            {mounted &&
                createPortal(
                    <div className="app-toast-stack">
                        {items.map((item) => {
                            const Icon = KIND_ICON[item.kind];
                            return (
                                <div key={item.id} className="app-toast-item" role="status">
                                    <Icon className={`app-toast-icon ${KIND_COLOR[item.kind]}`} size={16} />
                                    <span className="app-toast-message">{item.message}</span>
                                </div>
                            );
                        })}
                    </div>,
                    document.body
                )}
        </AppToastContext.Provider>
    );
}
