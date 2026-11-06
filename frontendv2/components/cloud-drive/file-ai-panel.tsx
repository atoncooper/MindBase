"use client";

/**
 * File AI panel - 文件级 AI 信息。
 *
 * 并行加载 AI 摘要与相似文件：摘要展示概览 / AI 标签（主题、实体）/ 关键点 /
 * 待办 / 可回答问题；相似文件展示内容相近的其他文件。两部分互不阻塞，任一
 * 请求失败只在该区域提示，不影响文件详情、预览与删除。
 *
 * 「问这份文件」进入限定该文件的对话（/chat?upload_uuid=...）。
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import {
    AlertCircle,
    Check,
    Loader2,
    MessageSquareText,
    Sparkles,
} from "lucide-react";
import {
    cloudApi,
    formatBytes,
    type CloudSummary,
    type CloudSummaryResponse,
    type SemanticHit,
} from "@/lib/api/cloud";
import { FileIconTile } from "./file-icon";
import { formatSimilarity } from "./helpers";

interface AiState {
    uuid: string;
    summary: CloudSummaryResponse | null;
    similar: SemanticHit[];
    summaryError: string | null;
    similarError: string | null;
}

interface FileAiPanelProps {
    uploadUuid: string;
    /** 相似文件点击后就地打开详情；缺省跳转 /cloud-drive/<uuid> */
    onSelectFile?: (uuid: string) => void;
}

export function FileAiPanel({ uploadUuid, onSelectFile }: FileAiPanelProps) {
    const [state, setState] = useState<AiState | null>(null);
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const [summary, similar] = await Promise.allSettled([
                cloudApi.getSummary(uploadUuid),
                cloudApi.getSimilar(uploadUuid, 5),
            ]);
            if (cancelled) return;
            setState({
                uuid: uploadUuid,
                summary: summary.status === "fulfilled" ? summary.value : null,
                similar: similar.status === "fulfilled" ? similar.value.items : [],
                summaryError:
                    summary.status === "rejected"
                        ? errorMessage(summary.reason, "摘要加载失败")
                        : null,
                similarError:
                    similar.status === "rejected"
                        ? errorMessage(similar.reason, "相似文件加载失败")
                        : null,
            });
        })();
        return () => {
            cancelled = true;
        };
    }, [uploadUuid, reloadKey]);

    // 按 uuid 缓存：切换文件时旧文件的数据立即失效，不闪现在新文件上。
    const current = state && state.uuid === uploadUuid ? state : null;
    const loading = current == null;
    const response = current?.summary ?? null;
    const summary = response?.available ? response.summary : null;

    const retry = () => {
        setState(null);
        setReloadKey((k) => k + 1);
    };

    return (
        <div className="space-y-5">
            {/* AI 摘要 */}
            <section>
                <SectionTitle
                    icon={<Sparkles className="h-3.5 w-3.5" />}
                    title="AI 摘要"
                    trailing={
                        response?.stale ? (
                            <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10.5px] text-warning">
                                内容已更新，摘要可能过时
                            </span>
                        ) : null
                    }
                />
                {loading ? (
                    <LoadingRow text="正在加载摘要…" />
                ) : current?.summaryError ? (
                    <ErrorRow message={current.summaryError} onRetry={retry} />
                ) : summary ? (
                    <SummaryBody summary={summary} response={response} />
                ) : (
                    <NoSummary />
                )}
            </section>

            {/* 文件级 AI 操作 */}
            <Link
                href={`/chat?upload_uuid=${encodeURIComponent(uploadUuid)}`}
                className="btn-pill btn-ghost h-10 w-full text-[12.5px] md:h-9"
            >
                <MessageSquareText className="h-4 w-4" />
                问这份文件
            </Link>

            {/* 相似文件 */}
            <section>
                <SectionTitle title="相似文件" />
                {loading ? (
                    <LoadingRow text="正在查找相似文件…" />
                ) : current?.similarError ? (
                    <ErrorRow message={current.similarError} onRetry={retry} />
                ) : current && current.similar.length > 0 ? (
                    <ul className="mt-2 space-y-1.5">
                        {current.similar.map((hit) => (
                            <li key={hit.uploadUuid}>
                                <SimilarRow hit={hit} onSelectFile={onSelectFile} />
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="mt-1.5 text-[12px] text-tertiary">
                        暂无可参照的相似文件
                    </p>
                )}
            </section>
        </div>
    );
}

function SummaryBody({
    summary,
    response,
}: {
    summary: CloudSummary;
    response: CloudSummaryResponse | null;
}) {
    const topics = summary.topics ?? [];
    const entities = summary.entities ?? [];
    const keyPoints = summary.keyPoints ?? [];
    const todos = summary.todos ?? [];
    const questions = summary.answersQuestions ?? [];

    return (
        <div className="mt-2 space-y-3">
            {summary.overview ? (
                <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground">
                    {summary.overview}
                </p>
            ) : null}

            {topics.length > 0 || entities.length > 0 ? (
                <div>
                    <SubLabel>AI 标签</SubLabel>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {topics.map((topic) => (
                            <Chip key={`topic-${topic}`} tone="accent">
                                {topic}
                            </Chip>
                        ))}
                        {entities.map((entity) => (
                            <Chip key={`entity-${entity}`}>{entity}</Chip>
                        ))}
                    </div>
                </div>
            ) : null}

            {keyPoints.length > 0 ? (
                <div>
                    <SubLabel>关键点</SubLabel>
                    <ul className="mt-1.5 space-y-1">
                        {keyPoints.map((point, i) => (
                            <li
                                key={i}
                                className="flex gap-1.5 text-[12px] leading-relaxed text-secondary"
                            >
                                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent" />
                                <span className="min-w-0">{point}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}

            {todos.length > 0 ? (
                <div>
                    <SubLabel>待办</SubLabel>
                    <ul className="mt-1.5 space-y-1">
                        {todos.map((todo, i) => (
                            <li
                                key={i}
                                className="flex gap-1.5 text-[12px] leading-relaxed text-secondary"
                            >
                                <Check className="mt-0.5 h-3 w-3 shrink-0 text-accent" aria-hidden="true" />
                                <span className="min-w-0">{todo}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}

            {questions.length > 0 ? (
                <div>
                    <SubLabel>可回答问题</SubLabel>
                    <ul className="mt-1.5 space-y-1">
                        {questions.map((question, i) => (
                            <li
                                key={i}
                                className="rounded-lg border border-border-subtle bg-surface px-2 py-1.5 text-[11.5px] leading-relaxed text-foreground"
                            >
                                {question}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}

            {response?.model ? (
                <p className="text-[10.5px] text-tertiary">
                    由 {response.model} 生成
                    {summary.sizeChars > 0 ? ` · 约 ${summary.sizeChars} 字` : ""}
                </p>
            ) : null}
        </div>
    );
}

function NoSummary() {
    return (
        <div className="mt-2 rounded-xl border border-border-subtle bg-surface px-3 py-3">
            <p className="text-[12px] text-secondary">摘要尚未生成</p>
        </div>
    );
}

function SimilarRow({
    hit,
    onSelectFile,
}: {
    hit: SemanticHit;
    onSelectFile?: (uuid: string) => void;
}) {
    const name = hit.title || hit.originalName;
    const className =
        "flex w-full items-center gap-2.5 rounded-xl border border-border-subtle bg-surface px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-border-subtle/40";
    const content = (
        <>
            <FileIconTile mimeType={hit.mimeType} size="sm" />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-foreground">{name}</span>
                <span className="mt-0.5 block truncate text-[10.5px] text-tertiary">
                    {formatBytes(hit.fileSize)}
                    {hit.snippets && hit.snippets[0] ? ` · ${hit.snippets[0]}` : ""}
                </span>
            </span>
            <span className="shrink-0 text-[10.5px] tabular-nums text-accent">
                {formatSimilarity(hit.score)}
            </span>
        </>
    );

    if (onSelectFile) {
        return (
            <button
                type="button"
                onClick={() => onSelectFile(hit.uploadUuid)}
                className={className}
            >
                {content}
            </button>
        );
    }
    return (
        <Link href={`/cloud-drive/${hit.uploadUuid}`} className={className}>
            {content}
        </Link>
    );
}

function SectionTitle({
    title,
    icon,
    trailing,
}: {
    title: string;
    icon?: React.ReactNode;
    trailing?: React.ReactNode;
}) {
    return (
        <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-tertiary">
                {icon}
                {title}
            </h3>
            {trailing}
        </div>
    );
}

function SubLabel({ children }: { children: React.ReactNode }) {
    return <p className="text-[10.5px] font-medium text-tertiary">{children}</p>;
}

function Chip({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "accent" }) {
    return (
        <span
            className={
                tone === "accent"
                    ? "rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent"
                    : "rounded-full border border-border-subtle bg-surface px-2 py-0.5 text-[11px] text-secondary"
            }
        >
            {children}
        </span>
    );
}

function LoadingRow({ text }: { text: string }) {
    return (
        <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-tertiary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {text}
        </p>
    );
}

function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div className="mt-2 flex items-start gap-2 rounded-xl border border-border-subtle bg-surface px-3 py-2 text-[11.5px] text-secondary">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
            <div className="min-w-0 flex-1">
                <p className="break-words">{message}</p>
                <button
                    type="button"
                    onClick={onRetry}
                    className="mt-1 text-accent transition-opacity hover:opacity-80"
                >
                    重试
                </button>
            </div>
        </div>
    );
}

function errorMessage(reason: unknown, fallback: string): string {
    if (reason instanceof Error && reason.message) return reason.message;
    return fallback;
}
