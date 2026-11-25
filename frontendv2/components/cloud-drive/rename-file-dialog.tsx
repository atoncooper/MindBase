"use client";

/** Small modal for renaming a cloud-drive file (documents + videos). */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

export function RenameFileDialog({
    open,
    initialName,
    busy = false,
    error,
    onClose,
    onConfirm,
}: {
    open: boolean;
    initialName: string;
    busy?: boolean;
    error?: string | null;
    onClose: () => void;
    onConfirm: (name: string) => void;
}) {
    const [name, setName] = useState(initialName);

    useEffect(() => {
        if (open) setName(initialName);
    }, [open, initialName]);

    if (!open) return null;

    const trimmed = name.trim();
    const canSubmit = trimmed.length > 0 && trimmed.length <= 255 && !busy && trimmed !== initialName;

    return (
        <div
            className="fixed inset-0 z-[80] grid place-items-center bg-black/30 p-4 backdrop-blur-[2px]"
            onClick={() => {
                if (!busy) onClose();
            }}
            role="dialog"
            aria-modal="true"
            aria-label="重命名文件"
        >
            <div
                className="w-full max-w-sm rounded-2xl border border-border-subtle bg-surface p-5 shadow-2xl"
                onClick={(event) => event.stopPropagation()}
            >
                <h3 className="text-[15px] font-semibold tracking-tight text-foreground">重命名</h3>
                <p className="mt-1 text-[11.5px] text-secondary">修改文件显示名称，不会移动或重新上传文件。</p>
                <input
                    autoFocus
                    value={name}
                    maxLength={255}
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && canSubmit) onConfirm(trimmed);
                        if (event.key === "Escape" && !busy) onClose();
                    }}
                    aria-label="文件名"
                    className="mt-3 h-10 w-full rounded-xl border border-border bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-accent"
                />
                {error && <p className="mt-2 text-[11.5px] text-danger">{error}</p>}
                <div className="mt-4 flex items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={busy}
                        className="btn-pill btn-ghost h-9 px-4 text-[12.5px] disabled:opacity-50"
                    >
                        取消
                    </button>
                    <button
                        type="button"
                        onClick={() => onConfirm(trimmed)}
                        disabled={!canSubmit}
                        className="btn-pill btn-primary inline-flex h-9 items-center gap-1.5 px-4 text-[12.5px] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                        保存
                    </button>
                </div>
            </div>
        </div>
    );
}
