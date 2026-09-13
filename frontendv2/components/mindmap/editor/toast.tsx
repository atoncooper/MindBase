"use client";

/**
 * Minimal toast host for the mind-map editor (ported from desktop's
 * lib/toast API surface: useToast() -> { success, error, info }).
 *
 * frontendv2 has no global toast host yet (notes-view has a TODO); this is a
 * self-contained local implementation rendered via portal, styled after the
 * Apple-ish design tokens. When a global toast host lands, swap the provider
 * mounting and delete this file.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Info, XCircle } from "lucide-react";

interface ToastOptions {
    title?: string;
    duration?: number;
}

interface ToastItem {
    id: number;
    kind: "success" | "error" | "info";
    title?: string;
    message: string;
}

export interface ToastApi {
    success(message: string, options?: ToastOptions): void;
    error(message: string, options?: ToastOptions): void;
    info(message: string, options?: ToastOptions): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const KIND_ICON = {
    success: CheckCircle2,
    error: XCircle,
    info: Info,
} as const;

const KIND_COLOR = {
    success: "text-success",
    error: "text-danger",
    info: "text-accent",
} as const;

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [items, setItems] = useState<ToastItem[]>([]);
    const nextId = useRef(1);
    const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

    const dismiss = useCallback((id: number) => {
        setItems((prev) => prev.filter((t) => t.id !== id));
        const timer = timers.current.get(id);
        if (timer !== undefined) {
            clearTimeout(timer);
            timers.current.delete(id);
        }
    }, []);

    const push = useCallback(
        (kind: ToastItem["kind"], message: string, options?: ToastOptions) => {
            const id = nextId.current;
            nextId.current += 1;
            setItems((prev) => [...prev.slice(-4), { id, kind, title: options?.title, message }]);
            timers.current.set(
                id,
                setTimeout(() => dismiss(id), options?.duration ?? (kind === "error" ? 8000 : 4000)),
            );
        },
        [dismiss],
    );

    const api = useMemo<ToastApi>(
        () => ({
            success: (m, o) => push("success", m, o),
            error: (m, o) => push("error", m, o),
            info: (m, o) => push("info", m, o),
        }),
        [push],
    );

    return (
        <ToastContext.Provider value={api}>
            {children}
            {typeof document !== "undefined" &&
                createPortal(
                    <div className="pointer-events-none fixed bottom-6 right-6 z-[100] flex w-80 flex-col gap-2">
                        {items.map((t) => {
                            const Icon = KIND_ICON[t.kind];
                            return (
                                <div
                                    key={t.id}
                                    className="pointer-events-auto flex items-start gap-3 rounded-xl bg-surface px-4 py-3 shadow-lg ring-1 ring-border-subtle"
                                    onClick={() => dismiss(t.id)}
                                >
                                    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${KIND_COLOR[t.kind]}`} />
                                    <div className="min-w-0 flex-1">
                                        {t.title && (
                                            <div className="text-[13px] font-medium">{t.title}</div>
                                        )}
                                        <div className="break-words text-xs text-secondary">{t.message}</div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>,
                    document.body,
                )}
        </ToastContext.Provider>
    );
}

/** Editor-facing toast API. Must be used under <ToastProvider>. */
export function useToast(): ToastApi {
    const ctx = useContext(ToastContext);
    if (ctx === null) {
        throw new Error("useToast must be used within <ToastProvider>");
    }
    return ctx;
}
