"use client";

/**
 * SkillPreviewDrawer - right-side sheet rendering an installed skill's content.
 *
 * Loads SKILL.md body (rendered as Markdown) + file list + manifest summary.
 * Slides in from the right, full-height, max 640px. Closes on Escape / overlay
 * click / close button.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, AlertCircle, FileText, Code2 } from "lucide-react";
import { skillsApi, type SkillPreview } from "@/lib/api";
import { Markdown } from "@/components/markdown";

interface Props {
    skillId: string | null;
    onClose: () => void;
}

export function SkillPreviewDrawer({ skillId, onClose }: Props) {
    return (
        <AnimatePresence>
            {skillId && (
                <DrawerShell onClose={onClose}>
                    <DrawerBody skillId={skillId} onClose={onClose} />
                </DrawerShell>
            )}
        </AnimatePresence>
    );
}

function DrawerShell({
    onClose,
    children,
}: {
    onClose: () => void;
    children: React.ReactNode;
}) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    return createPortal(
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[100] bg-black/30"
            onClick={onClose}
        >
            <motion.div
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ duration: 0.28, ease: [0.28, 0.11, 0.32, 1] }}
                onClick={(e) => e.stopPropagation()}
                className="ml-auto flex h-full w-full max-w-[640px] flex-col border-l border-border-subtle bg-background"
            >
                {children}
            </motion.div>
        </motion.div>,
        document.body,
    );
}

function DrawerBody({
    skillId,
    onClose,
}: {
    skillId: string;
    onClose: () => void;
}) {
    const [data, setData] = useState<SkillPreview | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const p = await skillsApi.preview(skillId);
                if (!cancelled) setData(p);
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : "加载失败");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [skillId]);

    return (
        <div className="flex h-full flex-col">
            <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
                <div className="min-w-0">
                    <h2 className="truncate text-[15px] font-semibold tracking-tight text-foreground">
                        {data?.name ?? skillId}
                    </h2>
                    {(data?.version || data?.has_code_tools) && (
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-tertiary">
                            {data?.version && <span>v{data.version}</span>}
                            {data?.has_code_tools && (
                                <span className="inline-flex items-center gap-1">
                                    <Code2 className="h-3 w-3" /> 代码工具
                                </span>
                            )}
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                    aria-label="关闭"
                >
                    <X className="h-4 w-4" />
                </button>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-6">
                {loading ? (
                    <div className="flex justify-center py-16">
                        <Loader2 className="h-5 w-5 animate-spin text-tertiary" />
                    </div>
                ) : error ? (
                    <div className="flex items-start gap-2 rounded-lg border-l-2 border-foreground bg-border-subtle px-3 py-2.5 text-[12px] text-foreground">
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {error}
                    </div>
                ) : data ? (
                    <>
                        {data.description && (
                            <p className="mb-5 text-[13px] text-secondary">
                                {data.description}
                            </p>
                        )}
                        {data.body.trim() ? (
                            <div className="note-prose">
                                <Markdown>{data.body}</Markdown>
                            </div>
                        ) : (
                            <p className="text-[13px] text-tertiary">
                                该技能无 SKILL.md 正文
                            </p>
                        )}

                        {data.files.length > 0 && (
                            <div className="mt-8">
                                <h3 className="text-[11px] font-medium uppercase tracking-wider text-tertiary">
                                    文件 ({data.files.length})
                                </h3>
                                <ul className="mt-3 space-y-1">
                                    {data.files.map((f) => (
                                        <li
                                            key={f.path}
                                            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-secondary hover:bg-border-subtle"
                                        >
                                            <FileText className="h-3.5 w-3.5 shrink-0 text-tertiary" />
                                            <span className="min-w-0 flex-1 truncate text-foreground">
                                                {f.path}
                                            </span>
                                            <span className="shrink-0 text-[11px] text-tertiary">
                                                {fmtSize(f.size)}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </>
                ) : null}
            </div>
        </div>
    );
}

function fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
