"use client";

import { Loader2, Pencil, ShieldCheck, Star, Trash2, Zap } from "lucide-react";

/** Common display shape for LLM credentials and embedding/asr configs. */
export interface DisplayItem {
    id: number;
    name: string;
    provider: string;
    masked_key: string;
    base_url: string | null;
    model: string | null;
    is_default: boolean;
    last_test_status: string | null;
    last_test_error: string | null;
}

interface Props {
    item: DisplayItem;
    testing: boolean;
    onTest: () => void;
    onEdit: () => void;
    onSetDefault: () => void;
    onDelete: () => void;
}

export function CredentialCard({
    item,
    testing,
    onTest,
    onEdit,
    onSetDefault,
    onDelete,
}: Props) {
    return (
        <div className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface p-4">
            <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[14px] font-semibold text-foreground">
                        {item.name}
                    </span>
                    {item.is_default && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-success">
                            <ShieldCheck className="h-2.5 w-2.5" />
                            默认
                        </span>
                    )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                    <IconButton title="测试连接" onClick={onTest} disabled={testing}>
                        {testing ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Zap className="h-3.5 w-3.5" />
                        )}
                    </IconButton>
                    <IconButton title="编辑" onClick={onEdit}>
                        <Pencil className="h-3.5 w-3.5" />
                    </IconButton>
                    {!item.is_default && (
                        <IconButton title="设为默认" onClick={onSetDefault}>
                            <Star className="h-3.5 w-3.5" />
                        </IconButton>
                    )}
                    <IconButton title="删除" onClick={onDelete} danger>
                        <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="rounded-full bg-border-subtle px-2 py-0.5 font-medium capitalize text-secondary">
                    {item.provider}
                </span>
                <span className="rounded-full bg-border-subtle px-2 py-0.5 font-mono text-secondary">
                    {item.masked_key}
                </span>
                {item.model && (
                    <span className="rounded-full bg-border-subtle px-2 py-0.5 text-tertiary">
                        {item.model}
                    </span>
                )}
                {item.last_test_status === "ok" && (
                    <span
                        className="inline-flex items-center gap-1 text-success"
                        title="连接正常"
                    >
                        ● 正常
                    </span>
                )}
            </div>

            {item.last_test_status === "error" && item.last_test_error && (
                <p className="line-clamp-2 text-[11px] text-danger">
                    {item.last_test_error}
                </p>
            )}
        </div>
    );
}

function IconButton({
    title,
    onClick,
    disabled,
    danger,
    children,
}: {
    title: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            title={title}
            onClick={onClick}
            disabled={disabled}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-secondary transition-colors hover:bg-border-subtle disabled:opacity-40 ${
                danger ? "hover:text-danger" : "hover:text-foreground"
            }`}
        >
            {children}
        </button>
    );
}
