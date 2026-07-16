"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    Plus,
    Trash2,
    Share2,
    Search,
    X,
} from "lucide-react";
import {
    notesApi,
    type NoteMeta,
    type NoteDetail,
    type NoteShareInfo,
} from "@/lib/api";
import NoteEditor from "./editor";
import ShareDialog from "./share-dialog";
import "./notes.css";

type TargetType = "video" | "cloud_file";

function targetLabel(t: TargetType, id: string): string {
    if (t === "video") {
        if (id.startsWith("scratch:")) return "速记";
        const [bvid, cid] = id.split(":");
        return cid ? `视频 ${bvid} · P${cid}` : `视频 ${bvid}`;
    }
    return `云盘文件 #${id}`;
}

function timeAgo(iso: string): string {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const diff = Date.now() - t;
    const min = Math.floor(diff / 60000);
    if (min < 1) return "刚刚";
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day} 天前`;
    return new Date(iso).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

// Recency bucket for editorial-style date group headers.
const BUCKET_ORDER = ["今日", "昨日", "本周", "本月", "更早"] as const;
function bucketOf(iso: string, now: Date): string {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "更早";
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 86_400_000;
    const startOfWeek = startOfToday - 6 * 86_400_000;
    const startOfMonth = startOfToday - 29 * 86_400_000;
    if (t >= startOfToday) return "今日";
    if (t >= startOfYesterday) return "昨日";
    if (t >= startOfWeek) return "本周";
    if (t >= startOfMonth) return "本月";
    return "更早";
}

export default function NotesPanel() {
    const [notes, setNotes] = useState<NoteMeta[]>([]);
    const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
    const [detail, setDetail] = useState<NoteDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [showShare, setShowShare] = useState(false);
    const [shareInfo, setShareInfo] = useState<NoteShareInfo | null>(null);
    const [query, setQuery] = useState("");

    const refreshList = useCallback(async () => {
        setLoading(true);
        try {
            const list = await notesApi.list({ pageSize: 100 });
            setNotes(list);
            if (!selectedUuid && list.length > 0) {
                setSelectedUuid(list[0].uuid);
            }
        } finally {
            setLoading(false);
        }
    }, [selectedUuid]);

    const refreshDetail = useCallback(async () => {
        if (!selectedUuid) {
            setDetail(null);
            return;
        }
        const d = await notesApi.get(selectedUuid);
        setDetail(d);
        setShareInfo(
            d.shareToken
                ? {
                      shareToken: d.shareToken,
                      shareUrl: `/notes/shared/${d.shareToken}`,
                      expiresAt: d.shareExpiresAt,
                  }
                : null,
        );
    }, [selectedUuid]);

    useEffect(() => {
        refreshList();
    }, [refreshList]);

    useEffect(() => {
        refreshDetail();
    }, [refreshDetail]);

    const createNew = async () => {
        const created = await notesApi.create({
            targetType: "video",
            targetId: `scratch:${Date.now()}`,
            title: "无标题",
            contentMd: "",
        });
        await refreshList();
        setSelectedUuid(created.uuid);
    };

    const remove = async (uuid: string) => {
        if (!confirm("确定删除这条笔记？此操作不可撤销。")) return;
        await notesApi.delete(uuid);
        if (selectedUuid === uuid) {
            setSelectedUuid(null);
        }
        await refreshList();
    };

    const togglePin = async (note: NoteMeta) => {
        await notesApi.update(note.uuid, { isPinned: !note.isPinned });
        await refreshList();
    };

    const filtered = query.trim()
        ? notes.filter(
              (n) =>
                  n.title.toLowerCase().includes(query.toLowerCase()) ||
                  targetLabel(n.targetType, n.targetId)
                      .toLowerCase()
                      .includes(query.toLowerCase()),
          )
        : notes;

    const sorted = [...filtered].sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    // Stable folio numbers: derived from the FULL list (unfiltered), so
    // searching no longer renumbers every visible row. Pinned still sort
    // first, so their folios reflect the canonical archive order.
    const folioMap = useMemo(() => {
        const full = [...notes].sort((a, b) => {
            if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
            return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        });
        const m = new Map<string, string>();
        full.forEach((n, i) => m.set(n.uuid, String(i + 1).padStart(2, "0")));
        return m;
    }, [notes]);

    // Group visible notes: pinned first, then by recency bucket. Mirrors the
    // editorial-archive feel of the chat-history sidebar.
    const groups = useMemo(() => {
        const now = new Date();
        const result: { label: string; notes: NoteMeta[] }[] = [];
        const pinned = sorted.filter((n) => n.isPinned);
        if (pinned.length) result.push({ label: "置顶", notes: pinned });
        const buckets: Record<string, NoteMeta[]> = {};
        for (const n of sorted) {
            if (n.isPinned) continue;
            const b = bucketOf(n.updatedAt, now);
            (buckets[b] ??= []).push(n);
        }
        for (const label of BUCKET_ORDER) {
            if (buckets[label]?.length) {
                result.push({ label, notes: buckets[label] });
            }
        }
        return result;
    }, [sorted]);

    return (
        <div className="notes-scope flex h-full bg-[var(--note-paper)]">
            {/* Sidebar */}
            <div
                className="w-72 flex flex-col"
                style={{ borderRight: "1px solid var(--note-line)" }}
            >
                {/* Header */}
                <div
                    className="px-5 pt-5 pb-4 flex items-center justify-between"
                    style={{ borderBottom: "1px solid var(--note-line-soft)" }}
                >
                    <div className="flex flex-col gap-1">
                        <span
                            className="note-eyebrow"
                            style={{ color: "var(--note-folio)" }}
                        >
                            Atelier
                        </span>
                        <div className="flex items-baseline gap-2.5">
                            <span
                                style={{
                                    fontFamily: "var(--note-serif)",
                                    fontSize: 24,
                                    fontWeight: 500,
                                    color: "var(--note-ink)",
                                    letterSpacing: "-0.018em",
                                    fontVariationSettings: '"opsz" 48',
                                }}
                            >
                                笔记
                            </span>
                            <span
                                style={{
                                    fontFamily: "var(--note-serif)",
                                    fontStyle: "italic",
                                    fontSize: 13,
                                    color: "var(--note-folio)",
                                    fontVariationSettings: '"opsz" 9',
                                }}
                            >
                                №&nbsp;{String(notes.length).padStart(2, "0")}
                            </span>
                        </div>
                    </div>
                    <button
                        onClick={createNew}
                        className="note-btn is-ghost"
                        title="新建笔记"
                        aria-label="新建笔记"
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                </div>

                {/* Search */}
                <div className="px-4 py-3">
                    <div
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
                        style={{
                            background: "var(--note-paper-sunken)",
                            border: "1px solid transparent",
                            transition: "border-color 180ms var(--note-ease)",
                        }}
                        onFocus={(e) =>
                            (e.currentTarget.style.borderColor = "var(--note-line)")
                        }
                        onBlur={(e) =>
                            (e.currentTarget.style.borderColor = "transparent")
                        }
                    >
                        <Search className="w-3.5 h-3.5" style={{ color: "var(--note-ink-faint)" }} />
                        <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="搜索…"
                            className="flex-1 bg-transparent outline-none text-sm"
                            style={{
                                fontFamily: "var(--note-sans)",
                                color: "var(--note-ink)",
                            }}
                        />
                        {query && (
                            <button
                                onClick={() => setQuery("")}
                                className="note-search-clear"
                                aria-label="清除搜索"
                                title="清除搜索"
                            >
                                <X className="w-2.5 h-2.5" />
                            </button>
                        )}
                    </div>
                </div>

                {/* List */}
                <div className="flex-1 overflow-auto">
                    {loading && notes.length === 0 && (
                        <>
                            {[0, 1, 2, 3].map((i) => (
                                <div className="note-skel" key={i}>
                                    <div className="note-skel-mark">
                                        <span />
                                    </div>
                                    <div className="note-skel-body">
                                        <div className="note-skel-line" />
                                        <div className="note-skel-line" />
                                        <div className="note-skel-line" />
                                    </div>
                                </div>
                            ))}
                        </>
                    )}
                    {!loading && sorted.length === 0 && (
                        <div
                            className="px-5 py-10 flex flex-col items-start gap-1"
                            style={{ color: "var(--note-ink-faint)" }}
                        >
                            <span
                                style={{
                                    fontFamily: "var(--note-serif)",
                                    fontStyle: "italic",
                                    fontSize: 40,
                                    color: "var(--note-folio)",
                                    opacity: 0.5,
                                    lineHeight: 1,
                                    marginBottom: 6,
                                    fontVariationSettings: '"opsz" 144',
                                }}
                            >
                                ❦
                            </span>
                            {query ? (
                                <>
                                    <span
                                        className="note-eyebrow"
                                        style={{ color: "var(--note-ink-soft)" }}
                                    >
                                        无匹配
                                    </span>
                                    <span
                                        style={{
                                            fontFamily: "var(--note-serif)",
                                            fontStyle: "italic",
                                            fontSize: 14,
                                            color: "var(--note-ink-soft)",
                                            fontVariationSettings: '"opsz" 24',
                                        }}
                                    >
                                        没有「{query}」相关的笔记
                                    </span>
                                </>
                            ) : (
                                <>
                                    <span className="note-eyebrow">Folio</span>
                                    <span
                                        style={{
                                            fontFamily: "var(--note-serif)",
                                            fontStyle: "italic",
                                            fontSize: 15,
                                            color: "var(--note-ink-soft)",
                                            fontVariationSettings: '"opsz" 24',
                                        }}
                                    >
                                        还没有笔记。落笔写下第一条吧。
                                    </span>
                                    <button
                                        onClick={createNew}
                                        className="note-first-cta"
                                    >
                                        <Plus className="w-3.5 h-3.5" />
                                        新建笔记
                                    </button>
                                </>
                            )}
                        </div>
                    )}
                    {!loading &&
                        groups.map((g) => (
                            <div key={g.label}>
                                <div className="note-group">
                                    <span>{g.label}</span>
                                    <span className="note-group-count">
                                        {String(g.notes.length).padStart(2, "0")}
                                    </span>
                                </div>
                                {g.notes.map((n, i) => {
                                    const isSelected = selectedUuid === n.uuid;
                                    const folio = folioMap.get(n.uuid) ?? "·";
                                    return (
                                        <div
                                            key={n.uuid}
                                            role="button"
                                            tabIndex={0}
                                            onClick={() => setSelectedUuid(n.uuid)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter" || e.key === " ") {
                                                    e.preventDefault();
                                                    setSelectedUuid(n.uuid);
                                                }
                                            }}
                                            className={`note-row note-stagger ${isSelected ? "is-selected" : ""}`}
                                            style={{ animationDelay: `${Math.min(i * 24, 192)}ms` }}
                                        >
                                            <span className="note-folio">§{folio}</span>
                                            <div className="note-row-body flex flex-col min-w-0">
                                                <div className="flex items-start gap-2">
                                                    {n.isPinned && (
                                                        <span className="note-pin-dot mt-1.5" />
                                                    )}
                                                    <div className="flex-1 min-w-0">
                                                        <div
                                                            className="text-sm truncate"
                                                            style={{
                                                                fontFamily: "var(--note-sans)",
                                                                color: "var(--note-ink)",
                                                                fontWeight: 600,
                                                                lineHeight: 1.32,
                                                                letterSpacing: "-0.005em",
                                                            }}
                                                        >
                                                            {n.title || "无标题"}
                                                        </div>
                                                        <div
                                                            className="flex items-center gap-1.5 mt-1 text-xs"
                                                            style={{
                                                                color: "var(--note-ink-faint)",
                                                                fontFamily: "var(--note-sans)",
                                                            }}
                                                        >
                                                            <span className="truncate">
                                                                {targetLabel(n.targetType, n.targetId)}
                                                            </span>
                                                            <span className="note-meta-sep">·</span>
                                                            <span className="flex-shrink-0">
                                                                {timeAgo(n.updatedAt)}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div
                                                    className="flex gap-1 mt-1.5 -ml-1"
                                                    style={{
                                                        opacity: isSelected ? 1 : 0,
                                                        transition: "opacity 150ms var(--note-ease)",
                                                    }}
                                                >
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            togglePin(n);
                                                        }}
                                                        className="note-btn is-ghost"
                                                        style={{ fontSize: 10.5, padding: "2px 7px" }}
                                                    >
                                                        {n.isPinned ? "取消置顶" : "置顶"}
                                                    </button>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            remove(n.uuid);
                                                        }}
                                                        className="note-btn is-ghost is-danger"
                                                        style={{ fontSize: 10.5, padding: "2px 7px" }}
                                                    >
                                                        删除
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                </div>
            </div>

            {/* Editor pane */}
            <div className="flex-1 flex flex-col min-w-0">
                {detail ? (
                    <>
                        <div
                            className="flex items-center justify-end gap-1 px-5 py-2"
                            style={{ borderBottom: "1px solid var(--note-line-soft)" }}
                        >
                            <button
                                onClick={() => setShowShare(true)}
                                className="note-btn"
                            >
                                <Share2 className="w-3.5 h-3.5" />
                                {shareInfo ? "管理分享" : "分享"}
                            </button>
                            <button
                                onClick={() => remove(detail.uuid)}
                                className="note-btn is-danger"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                                删除
                            </button>
                        </div>
                        <NoteEditor note={detail} onChanged={refreshDetail} />
                    </>
                ) : (
                    <div
                        className="flex-1 flex flex-col items-center justify-center gap-4"
                        style={{ color: "var(--note-ink-faint)" }}
                    >
                        <div
                            style={{
                                fontFamily: "var(--note-serif)",
                                fontStyle: "italic",
                                fontSize: 84,
                                color: "var(--note-folio)",
                                opacity: 0.5,
                                lineHeight: 1,
                                fontVariationSettings: '"opsz" 144',
                                marginBottom: 4,
                            }}
                        >
                            ❦
                        </div>
                        <div
                            className="note-eyebrow"
                            style={{ color: "var(--note-folio)" }}
                        >
                            Folio
                        </div>
                        <div
                            style={{
                                fontFamily: "var(--note-serif)",
                                fontStyle: "italic",
                                fontSize: 17,
                                color: "var(--note-ink-soft)",
                                fontVariationSettings: '"opsz" 24',
                            }}
                        >
                            选择左侧笔记，或新建一条开始落笔
                        </div>
                    </div>
                )}
            </div>

            {showShare && detail && (
                <ShareDialog
                    noteUuid={detail.uuid}
                    existing={shareInfo}
                    onClose={() => setShowShare(false)}
                    onShared={(info) => {
                        setShareInfo(info);
                        refreshDetail();
                    }}
                />
            )}
        </div>
    );
}
