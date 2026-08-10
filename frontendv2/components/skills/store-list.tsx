"use client";

/**
 * StoreList - search GitHub skill repos and install them in one click.
 *
 * Initial load fetches the default topic; the search box queries GitHub.
 * Install downloads the repo zipball and registers it as one skill; the row
 * flips to "已安装" on success and notifies the parent to refresh installed.
 */
import { useEffect, useState } from "react";
import { Search, Star, Download, Loader2, AlertCircle, Check, Box, ExternalLink, X } from "lucide-react";
import { skillsApi, type StoreRepo } from "@/lib/api";

interface Props {
    onInstalled: () => void;
}

export function StoreList({ onInstalled }: Props) {
    const [q, setQ] = useState("");
    const [items, setItems] = useState<StoreRepo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [installing, setInstalling] = useState<string | null>(null);
    const [done, setDone] = useState<Set<string>>(new Set());

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const list = await skillsApi.storeList(undefined);
                if (!cancelled) setItems(list);
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : "加载失败");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    async function search(query: string) {
        setLoading(true);
        setError(null);
        try {
            const list = await skillsApi.storeList(query || undefined);
            setItems(list);
        } catch (e) {
            setError(e instanceof Error ? e.message : "搜索失败");
        } finally {
            setLoading(false);
        }
    }

    async function install(repo: string, branch: string) {
        setInstalling(repo);
        setError(null);
        try {
            await skillsApi.storeInstall(repo, branch);
            setDone((prev) => new Set(prev).add(repo));
            onInstalled();
        } catch (e) {
            setError(e instanceof Error ? e.message : "安装失败");
        } finally {
            setInstalling(null);
        }
    }

    return (
        <div>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    void search(q);
                }}
                className="relative"
            >
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-tertiary" />
                <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="搜索技能仓库"
                    className="h-10 w-full rounded-full border border-transparent bg-border-subtle pl-10 pr-10 text-[14px] text-foreground outline-none transition-colors placeholder:text-tertiary focus:border-border focus:bg-surface"
                />
                {q && (
                    <button
                        type="button"
                        onClick={() => {
                            setQ("");
                            void search("");
                        }}
                        className="absolute right-2.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-tertiary transition-colors hover:bg-border hover:text-foreground"
                        aria-label="清除"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                )}
            </form>

            {error && (
                <div className="mt-4 flex items-start gap-2 rounded-lg border-l-2 border-foreground bg-border-subtle px-3 py-2.5 text-[12px] text-foreground">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {error}
                </div>
            )}

            {loading ? (
                <div className="mt-16 flex justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-tertiary" />
                </div>
            ) : items.length === 0 ? (
                <div className="mt-16 text-center text-[13px] text-tertiary">
                    未找到仓库
                </div>
            ) : (
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {items.map((r) => {
                        const isDone = done.has(r.full_name);
                        const isBusy = installing === r.full_name;
                        return (
                            <div
                                key={r.full_name}
                                className="flex flex-col rounded-lg border border-border-subtle bg-surface p-4"
                            >
                                <div className="flex items-start gap-2.5">
                                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-border-subtle text-foreground">
                                        <Box className="h-4 w-4" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <a
                                            href={r.html_url}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="inline-flex items-center gap-1 text-[13px] font-semibold text-foreground hover:underline"
                                        >
                                            <span className="truncate">{r.full_name}</span>
                                            <ExternalLink className="h-3 w-3 shrink-0 text-tertiary" />
                                        </a>
                                        <p className="mt-1 line-clamp-2 min-h-[2.6em] text-[12px] text-secondary">
                                            {r.description || "无描述"}
                                        </p>
                                    </div>
                                </div>

                                <div className="mt-2 flex items-center gap-3 text-[11px] text-tertiary">
                                    <span className="inline-flex items-center gap-1">
                                        <Star className="h-3 w-3" />
                                        {r.stargazers_count}
                                    </span>
                                    <span>{r.default_branch}</span>
                                </div>

                                <div className="mt-3 border-t border-border-subtle pt-3">
                                    <button
                                        type="button"
                                        onClick={() => void install(r.full_name, r.default_branch)}
                                        disabled={isBusy || isDone}
                                        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-40"
                                    >
                                        {isBusy ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : isDone ? (
                                            <Check className="h-3.5 w-3.5" />
                                        ) : (
                                            <Download className="h-3.5 w-3.5" />
                                        )}
                                        {isDone ? "已安装" : "安装"}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
