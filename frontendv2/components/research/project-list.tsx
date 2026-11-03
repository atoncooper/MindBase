"use client";

/**
 * 左侧项目列表：搜索（标题/领域/目标期刊，本地过滤已加载的数据）、阶段徽标、
 * 文献/稿件计数摘要，以及「新建项目」入口。选中项高亮，点击切换右侧详情。
 */
import { useMemo, useState } from "react";
import { FlaskConical, Loader2, Plus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AcademicProjectSummary } from "@/lib/api";
import {
    ErrorBanner,
    PAPER_TYPE_LABELS,
    STAGE_LABELS,
    StatusBadge,
    formatDate,
} from "./research-ui";

export function ProjectList({
    projects,
    loading,
    error,
    selectedId,
    onSelect,
    onRetry,
    onCreate,
}: {
    projects: AcademicProjectSummary[];
    loading: boolean;
    error: string | null;
    selectedId: string | null;
    onSelect: (projectId: string) => void;
    onRetry: () => void;
    onCreate: () => void;
}) {
    const [keyword, setKeyword] = useState("");

    const filtered = useMemo(() => {
        const q = keyword.trim().toLowerCase();
        if (!q) return projects;
        return projects.filter((project) => {
            const haystack = [project.title, project.field, project.targetJournal ?? ""]
                .join(" ")
                .toLowerCase();
            return haystack.includes(q);
        });
    }, [projects, keyword]);

    return (
        <aside className="flex min-h-0 flex-1 flex-col rounded-xl border border-border-subtle bg-surface">
            <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                <h2 className="text-[13px] font-semibold text-foreground">我的研究项目</h2>
                <button
                    type="button"
                    onClick={onCreate}
                    title="新建项目"
                    aria-label="新建项目"
                    className="grid h-7 w-7 place-items-center rounded-full bg-foreground text-surface transition-opacity hover:opacity-90"
                >
                    <Plus className="h-3.5 w-3.5" />
                </button>
            </div>

            <div className="px-3 pt-3">
                <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary" />
                    <input
                        value={keyword}
                        onChange={(e) => setKeyword(e.target.value)}
                        placeholder="搜索项目"
                        className="h-8 w-full rounded-full border border-transparent bg-border-subtle pl-8 pr-8 text-[12px] text-foreground outline-none transition-colors placeholder:text-tertiary focus:border-border focus:bg-surface"
                    />
                    {keyword && (
                        <button
                            type="button"
                            onClick={() => setKeyword("")}
                            aria-label="清除搜索"
                            className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full text-tertiary hover:bg-border hover:text-foreground"
                        >
                            <X className="h-3 w-3" />
                        </button>
                    )}
                </div>
            </div>

            {error && (
                <div className="px-3 pt-3">
                    <ErrorBanner message={error} onRetry={onRetry} />
                </div>
            )}

            <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {loading ? (
                    <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-tertiary">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        加载中…
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="px-2 py-10 text-center">
                        <FlaskConical className="mx-auto h-6 w-6 text-tertiary" />
                        <p className="mt-2 text-[12px] text-secondary">
                            {projects.length === 0 ? "还没有研究项目" : "没有匹配的项目"}
                        </p>
                        {projects.length === 0 && (
                            <button
                                type="button"
                                onClick={onCreate}
                                className="mt-3 inline-flex items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                            >
                                <Plus className="h-3 w-3" />
                                新建项目
                            </button>
                        )}
                    </div>
                ) : (
                    <ul className="space-y-1">
                        {filtered.map((project) => {
                            const active = project.id === selectedId;
                            return (
                                <li key={project.id}>
                                    <button
                                        type="button"
                                        onClick={() => onSelect(project.id)}
                                        className={cn(
                                            "w-full rounded-lg px-2.5 py-2 text-left transition-colors",
                                            active ? "bg-accent-soft" : "hover:bg-border-subtle",
                                        )}
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <span
                                                className={cn(
                                                    "min-w-0 flex-1 truncate text-[13px] font-medium",
                                                    active ? "text-accent" : "text-foreground",
                                                )}
                                            >
                                                {project.title}
                                            </span>
                                            <StatusBadge
                                                status={project.stages[project.stage]?.status ?? "locked"}
                                                className="shrink-0"
                                            />
                                        </div>
                                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-tertiary">
                                            <span>{PAPER_TYPE_LABELS[project.paperType]}</span>
                                            <span className="text-border">|</span>
                                            <span>阶段：{STAGE_LABELS[project.stage]}</span>
                                            <span className="text-border">|</span>
                                            <span>
                                                文献 {project.literatureCount} / 稿件 {project.documentCount}
                                            </span>
                                        </div>
                                        <div className="mt-0.5 text-[11px] text-tertiary">
                                            截止 {formatDate(project.deadline ? new Date(project.deadline).getTime() : undefined)}
                                            {" · "}
                                            更新 {formatDate(project.updatedAt)}
                                        </div>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </aside>
    );
}
