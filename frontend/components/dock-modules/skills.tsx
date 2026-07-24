"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { skillsApi, type InstalledSkill, type RepoContents, type SkillPreview, type StoreRepo } from "@/lib/api";
import type { DockPanelProps } from "@/lib/dock-registry";

/* ────────── Google × Apple design tokens ──────────
 * Google: Material color system (gemini-primary blue), elevation shadows,
 *         Roboto body. Apple: large radii, generous whitespace, refined
 *         spring motion, Geist (SF Pro / Google Sans geometry) display.
 * Real surfaces only - no glassmorphism. */
const DISPLAY = "var(--font-sans), var(--font-body), -apple-system, BlinkMacSystemFont, sans-serif";
const SANS = "var(--font-roboto), var(--font-body), -apple-system, sans-serif";
const MONO = "ui-monospace, 'SF Mono', var(--font-roboto), monospace";
const ACCENT = "var(--gemini-primary, #4285F4)";
const ACCENT_HOVER = "var(--gemini-primary-hover, #3367D6)";
const ACCENT_SOFT = "rgba(66,133,244,0.10)";
const R_CARD = 16;
const R_BTN = 12;
const SHADOW_1 = "0 1px 2px rgba(0,0,0,0.10), 0 1px 3px rgba(0,0,0,0.12)";
const SHADOW_2 = "0 8px 24px rgba(0,0,0,0.24)";
const SPRING = { type: "spring", stiffness: 380, damping: 30 } as const;

type Tab = "installed" | "store";

export default function SkillsPanel({ isOpen }: DockPanelProps) {
    const [tab, setTab] = useState<Tab>("installed");
    const [installed, setInstalled] = useState<InstalledSkill[]>([]);
    const [store, setStore] = useState<StoreRepo[]>([]);
    const [storeLoaded, setStoreLoaded] = useState(false);
    const [query, setQuery] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    // store browser state
    const [browsingRepo, setBrowsingRepo] = useState<string | null>(null);
    const [browsingBranch, setBrowsingBranch] = useState("main");
    const [browsePath, setBrowsePath] = useState("");
    const [browseContents, setBrowseContents] = useState<RepoContents | null>(null);
    const [browseLoading, setBrowseLoading] = useState(false);
    const [browseError, setBrowseError] = useState<string | null>(null);

    // installed preview state
    const [previewingSkill, setPreviewingSkill] = useState<string | null>(null);
    const [previewData, setPreviewData] = useState<SkillPreview | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);

    const loadInstalled = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setInstalled(await skillsApi.listInstalled());
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "加载失败");
        } finally {
            setLoading(false);
        }
    }, []);

    const loadStore = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setStore(await skillsApi.storeList(query || undefined));
            setStoreLoaded(true);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "商店访问失败");
        } finally {
            setLoading(false);
        }
    }, [query]);

    useEffect(() => {
        if (isOpen && tab === "installed") loadInstalled();
    }, [isOpen, tab, loadInstalled]);
    useEffect(() => {
        if (isOpen && tab === "store" && !storeLoaded) loadStore();
    }, [isOpen, tab, storeLoaded, loadStore]);

    const handleUninstall = async (skillId: string) => {
        setBusy(skillId);
        setError(null);
        try {
            await skillsApi.uninstall(skillId);
            await loadInstalled();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "卸载失败");
        } finally {
            setBusy(null);
        }
    };

    const handleStoreInstall = async (repo: string, branch: string) => {
        setBusy(repo);
        setError(null);
        try {
            await skillsApi.storeInstall(repo, branch);
            await loadInstalled();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "安装失败");
        } finally {
            setBusy(null);
        }
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setBusy("__upload__");
        setError(null);
        try {
            await skillsApi.uploadInstall(file);
            await loadInstalled();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "上传安装失败");
        } finally {
            setBusy(null);
            if (fileRef.current) fileRef.current.value = "";
        }
    };

    const loadContents = useCallback(
        async (repo: string, path: string, branch: string) => {
            setBrowseLoading(true);
            setBrowseError(null);
            try {
                setBrowseContents(await skillsApi.storeContents(repo, path, branch));
            } catch (e: unknown) {
                setBrowseError(e instanceof Error ? e.message : "加载失败");
                setBrowseContents(null);
            } finally {
                setBrowseLoading(false);
            }
        },
        [],
    );

    const openRepo = (repo: string, branch: string) => {
        setBrowsingRepo(repo);
        setBrowsingBranch(branch);
        setBrowsePath("");
        loadContents(repo, "", branch);
    };

    const enterDir = (path: string) => {
        if (!browsingRepo) return;
        setBrowsePath(path);
        loadContents(browsingRepo, path, browsingBranch);
    };

    const backToRepos = () => {
        setBrowsingRepo(null);
        setBrowseContents(null);
        setBrowsePath("");
        setBrowseError(null);
    };

    const loadPreview = useCallback(async (skillId: string) => {
        setPreviewLoading(true);
        setPreviewError(null);
        try {
            setPreviewData(await skillsApi.preview(skillId));
        } catch (e: unknown) {
            setPreviewError(e instanceof Error ? e.message : "预览失败");
            setPreviewData(null);
        } finally {
            setPreviewLoading(false);
        }
    }, []);

    const openPreview = (skillId: string) => {
        setPreviewingSkill(skillId);
        loadPreview(skillId);
    };

    const closePreview = () => {
        setPreviewingSkill(null);
        setPreviewData(null);
        setPreviewError(null);
    };

    if (!isOpen) return null;

    return (
        <div
            style={{
                minHeight: "100%",
                background: "var(--card)",
                color: "var(--foreground)",
                fontFamily: SANS,
                display: "flex",
                flexDirection: "column",
            }}
        >
            {/* ────────── masthead ────────── */}
            <header
                style={{
                    padding: "24px 28px 16px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 16,
                }}
            >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                    <div>
                        <h2
                            style={{
                                fontFamily: DISPLAY,
                                fontWeight: 600,
                                fontSize: 26,
                                margin: 0,
                                letterSpacing: "-0.02em",
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                            }}
                        >
                            技能商店
                            <span
                                style={{
                                    fontFamily: MONO,
                                    fontSize: 10,
                                    fontWeight: 500,
                                    letterSpacing: "0.16em",
                                    color: ACCENT,
                                    background: ACCENT_SOFT,
                                    padding: "3px 8px",
                                    borderRadius: 6,
                                    textTransform: "uppercase",
                                }}
                            >
                                Store
                            </span>
                        </h2>
                    </div>
                    <PrimaryButton
                        disabled={busy === "__upload__"}
                        onClick={() => fileRef.current?.click()}
                        busy={busy === "__upload__"}
                        small
                    >
                        {busy === "__upload__" ? "安装中…" : "上传 zip"}
                    </PrimaryButton>
                    <input ref={fileRef} type="file" accept=".zip" onChange={handleUpload} style={{ display: "none" }} />
                </div>

                <nav style={{ display: "flex", gap: 24, alignItems: "center" }}>
                    <TabLink active={tab === "installed"} onClick={() => setTab("installed")} label="已安装" count={installed.length} />
                    <TabLink active={tab === "store"} onClick={() => setTab("store")} label="商店" />
                    {tab === "store" && (
                        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                            <SearchInput value={query} onChange={setQuery} onSubmit={loadStore} />
                            <SecondaryButton onClick={loadStore} disabled={loading} small title="重新搜索（后端缓存 5 分钟）">
                                ↻
                            </SecondaryButton>
                        </div>
                    )}
                </nav>
            </header>

            <AnimatePresence>
                {error && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        style={{
                            background: "var(--danger-bg, rgba(239,68,68,0.1))",
                            color: "var(--danger)",
                            padding: "10px 28px",
                            fontSize: 13,
                            fontFamily: MONO,
                            borderBottom: "1px solid var(--border)",
                            overflow: "hidden",
                        }}
                    >
                        {error}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ────────── list ────────── */}
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 28px 24px" }}>
                {loading ? (
                    <LoadingState />
                ) : tab === "installed" ? (
                    previewingSkill ? (
                        <SkillPreviewView
                            skillId={previewingSkill}
                            data={previewData}
                            loading={previewLoading}
                            error={previewError}
                            onBack={closePreview}
                        />
                    ) : installed.length === 0 ? (
                        <EmptyState quote="尚未安装任何技能" hint="去商店遴选，或上传一份 zip" />
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            {installed.map((s, i) => (
                                <SkillCard
                                    key={s.skill_id}
                                    index={i}
                                    title={s.name}
                                    skillId={s.skill_id}
                                    description={s.description}
                                    version={s.version}
                                    hasCodeTools={s.has_code_tools}
                                    actionLabel="卸载"
                                    actionBusy={busy === s.skill_id}
                                    onAction={() => handleUninstall(s.skill_id)}
                                    onPreview={() => openPreview(s.skill_id)}
                                />
                            ))}
                        </div>
                    )
                ) : browsingRepo ? (
                    <RepoBrowser
                        repo={browsingRepo}
                        path={browsePath}
                        contents={browseContents}
                        loading={browseLoading}
                        error={browseError}
                        onEnterDir={enterDir}
                        onBack={backToRepos}
                        onInstall={() => handleStoreInstall(browsingRepo, browsingBranch)}
                        installBusy={busy === browsingRepo}
                    />
                ) : store.length === 0 ? (
                    <EmptyState quote="未搜到仓库" hint="输入关键词搜索 GitHub，或留空浏览 topic 市场" />
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        {store.map((r, i) => (
                            <RepoCard
                                key={r.full_name}
                                index={i}
                                fullName={r.full_name}
                                description={r.description}
                                stars={r.stargazers_count}
                                branch={r.default_branch}
                                htmlUrl={r.html_url}
                                actionLabel="安装"
                                actionBusy={busy === r.full_name}
                                onAction={() => handleStoreInstall(r.full_name, r.default_branch)}
                                onView={() => openRepo(r.full_name, r.default_branch)}
                            />
                        ))}
                    </div>
                )}
            </div>

            {/* ────────── footer ────────── */}
            <footer
                style={{
                    padding: "10px 28px",
                    borderTop: "1px solid var(--border)",
                    fontFamily: MONO,
                    fontSize: 10,
                    letterSpacing: "0.16em",
                    color: "var(--muted-foreground)",
                    textTransform: "uppercase",
                    display: "flex",
                    justifyContent: "space-between",
                }}
            >
                <span>{tab === "installed" ? `${installed.length} installed` : `${store.length} in store`}</span>
                <span>MinIO · per-user</span>
            </footer>
        </div>
    );
}

/* ────────── masthead pieces ────────── */

function TabLink({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
    return (
        <button
            onClick={onClick}
            style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "8px 0",
                fontFamily: SANS,
                fontSize: 14,
                fontWeight: 500,
                color: active ? "var(--foreground)" : "var(--muted-foreground)",
                position: "relative",
                display: "flex",
                alignItems: "baseline",
                gap: 6,
            }}
        >
            {label}
            {count !== undefined && (
                <span
                    style={{
                        fontFamily: MONO,
                        fontSize: 11,
                        color: active ? ACCENT : "var(--muted-foreground)",
                        background: active ? ACCENT_SOFT : "transparent",
                        padding: "1px 6px",
                        borderRadius: 8,
                    }}
                >
                    {count}
                </span>
            )}
            {active && (
                <motion.div
                    layoutId="tab-underline"
                    style={{ position: "absolute", left: 0, right: 0, bottom: -1, height: 2, background: ACCENT, borderRadius: 2 }}
                    transition={SPRING}
                />
            )}
        </button>
    );
}

function SearchInput({ value, onChange, onSubmit }: { value: string; onChange: (v: string) => void; onSubmit: () => void }) {
    return (
        <input
            type="text"
            placeholder="搜索 GitHub 仓库…"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            style={{
                width: 240,
                padding: "8px 14px",
                background: "var(--bg-input, rgba(255,255,255,0.04))",
                border: "1px solid var(--border)",
                borderRadius: R_BTN,
                color: "var(--foreground)",
                fontFamily: SANS,
                fontSize: 13,
                outline: "none",
                transition: "border-color 0.2s, box-shadow 0.2s",
            }}
            onFocus={(e) => {
                e.currentTarget.style.borderColor = ACCENT;
                e.currentTarget.style.boxShadow = `0 0 0 3px ${ACCENT_SOFT}`;
            }}
            onBlur={(e) => {
                e.currentTarget.style.borderColor = "var(--border)";
                e.currentTarget.style.boxShadow = "none";
            }}
        />
    );
}

/* ────────── buttons ────────── */

function PrimaryButton({
    children,
    disabled,
    onClick,
    busy,
    small,
}: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick: () => void;
    busy?: boolean;
    small?: boolean;
}) {
    return (
        <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={onClick}
            disabled={disabled}
            style={{
                padding: small ? "7px 14px" : "9px 18px",
                background: disabled ? "var(--border)" : ACCENT,
                color: "#fff",
                border: "none",
                borderRadius: R_BTN,
                fontFamily: SANS,
                fontSize: 13,
                fontWeight: 600,
                cursor: disabled ? "wait" : "pointer",
                opacity: disabled ? 0.7 : 1,
                whiteSpace: "nowrap",
                boxShadow: disabled ? "none" : SHADOW_1,
                transition: "background 0.2s",
            }}
            onMouseEnter={(e) => !disabled && (e.currentTarget.style.background = ACCENT_HOVER)}
            onMouseLeave={(e) => !disabled && (e.currentTarget.style.background = ACCENT)}
        >
            {busy ? "…" : children}
        </motion.button>
    );
}

function SecondaryButton({
    children,
    disabled,
    onClick,
    small,
    title,
}: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick: () => void;
    small?: boolean;
    title?: string;
}) {
    return (
        <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={onClick}
            disabled={disabled}
            title={title}
            style={{
                padding: small ? "7px 12px" : "9px 16px",
                background: "transparent",
                color: "var(--foreground)",
                border: "1px solid var(--border)",
                borderRadius: R_BTN,
                fontFamily: SANS,
                fontSize: 13,
                fontWeight: 500,
                cursor: disabled ? "wait" : "pointer",
                opacity: disabled ? 0.6 : 1,
                whiteSpace: "nowrap",
                transition: "border-color 0.2s, background 0.2s",
            }}
            onMouseEnter={(e) => !disabled && (e.currentTarget.style.borderColor = ACCENT)}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
        >
            {children}
        </motion.button>
    );
}

/* ────────── cards ────────── */

function CardShell({ index, children }: { index: number; children: React.ReactNode }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.34, delay: Math.min(index * 0.05, 0.4), ease: [0.22, 1, 0.36, 1] }}
            style={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: R_CARD,
                padding: 18,
                boxShadow: SHADOW_1,
                transition: "box-shadow 0.25s, transform 0.25s, border-color 0.25s",
            }}
            whileHover={{ y: -2 }}
            onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow = SHADOW_2;
                e.currentTarget.style.borderColor = "var(--border-hover, var(--border))";
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = SHADOW_1;
                e.currentTarget.style.borderColor = "var(--border)";
            }}
        >
            {children}
        </motion.div>
    );
}

function SkillCard({
    index,
    title,
    skillId,
    description,
    version,
    hasCodeTools,
    actionLabel,
    actionBusy,
    onAction,
    onPreview,
}: {
    index: number;
    title: string;
    skillId: string;
    description: string | null;
    version: string | null;
    hasCodeTools: boolean;
    actionLabel: string;
    actionBusy: boolean;
    onAction: () => void;
    onPreview?: () => void;
}) {
    return (
        <CardShell index={index}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <h3
                            style={{
                                fontFamily: DISPLAY,
                                fontWeight: 600,
                                fontSize: 17,
                                margin: 0,
                                letterSpacing: "-0.01em",
                                color: "var(--foreground)",
                            }}
                        >
                            {title}
                        </h3>
                        {version && (
                            <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--muted-foreground)" }}>v{version}</span>
                        )}
                        {hasCodeTools && <CodeToolsBadge />}
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: 11, color: "var(--muted-foreground)", marginTop: 4 }}>
                        #{skillId}
                    </div>
                    {description && (
                        <p
                            style={{
                                fontFamily: SANS,
                                fontSize: 13.5,
                                lineHeight: 1.5,
                                color: "var(--muted-foreground)",
                                margin: "8px 0 0",
                            }}
                        >
                            {description}
                        </p>
                    )}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                    {onPreview && (
                        <SecondaryButton onClick={onPreview} small>
                            预览
                        </SecondaryButton>
                    )}
                    <SecondaryButton onClick={onAction} small>
                        {actionBusy ? "…" : actionLabel}
                    </SecondaryButton>
                </div>
            </div>
        </CardShell>
    );
}

function RepoCard({
    index,
    fullName,
    description,
    stars,
    branch,
    htmlUrl,
    actionLabel,
    actionBusy,
    onAction,
    onView,
}: {
    index: number;
    fullName: string;
    description: string;
    stars: number;
    branch: string;
    htmlUrl: string;
    actionLabel: string;
    actionBusy: boolean;
    onAction: () => void;
    onView: () => void;
}) {
    return (
        <CardShell index={index}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <h3
                            style={{
                                fontFamily: DISPLAY,
                                fontWeight: 600,
                                fontSize: 17,
                                margin: 0,
                                letterSpacing: "-0.01em",
                                color: "var(--foreground)",
                            }}
                        >
                            {fullName}
                        </h3>
                    </div>
                    <div
                        style={{
                            fontFamily: MONO,
                            fontSize: 11,
                            color: "var(--muted-foreground)",
                            marginTop: 4,
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                        }}
                    >
                        <span>★ {stars}</span>
                        <span style={{ opacity: 0.5 }}>·</span>
                        <span>{branch}</span>
                        {htmlUrl && (
                            <a
                                href={htmlUrl}
                                target="_blank"
                                rel="noreferrer"
                                style={{ color: ACCENT, textDecoration: "none", opacity: 0.8, marginLeft: 4 }}
                            >
                                ↗
                            </a>
                        )}
                    </div>
                    {description && (
                        <p
                            style={{
                                fontFamily: SANS,
                                fontSize: 13.5,
                                lineHeight: 1.5,
                                color: "var(--muted-foreground)",
                                margin: "8px 0 0",
                            }}
                        >
                            {description}
                        </p>
                    )}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                    <SecondaryButton onClick={onView} small>
                        查看
                    </SecondaryButton>
                    <PrimaryButton onClick={onAction} busy={actionBusy} small>
                        {actionLabel}
                    </PrimaryButton>
                </div>
            </div>
        </CardShell>
    );
}

function CodeToolsBadge() {
    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "2px 8px",
                border: "1px solid var(--warning)",
                borderRadius: 8,
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: "0.04em",
                color: "var(--warning)",
                background: "var(--warning-bg, rgba(245,158,11,0.08))",
            }}
            title="含代码工具，需沙箱支持，当前暂不可执行"
        >
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--warning)" }} />
            代码·待沙箱
        </span>
    );
}

/* ────────── repo browser ────────── */

function RepoBrowser({
    repo,
    path,
    contents,
    loading,
    error,
    onEnterDir,
    onBack,
    onInstall,
    installBusy,
}: {
    repo: string;
    path: string;
    contents: RepoContents | null;
    loading: boolean;
    error: string | null;
    onEnterDir: (path: string) => void;
    onBack: () => void;
    onInstall: () => void;
    installBusy: boolean;
}) {
    const segments = path ? path.split("/").filter(Boolean) : [];
    return (
        <div
            style={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: R_CARD,
                boxShadow: SHADOW_1,
                overflow: "hidden",
            }}
        >
            <div
                style={{
                    padding: "12px 16px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flexWrap: "wrap",
                }}
            >
                <SecondaryButton onClick={onBack} small>
                    ← 返回
                </SecondaryButton>
                <div
                    style={{
                        fontFamily: MONO,
                        fontSize: 12,
                        color: "var(--muted-foreground)",
                        display: "flex",
                        gap: 4,
                        alignItems: "center",
                        flexWrap: "wrap",
                        minWidth: 0,
                    }}
                >
                    <BreadcrumbLink label={repo} onClick={() => onEnterDir("")} />
                    {segments.map((seg, i) => {
                        const segPath = segments.slice(0, i + 1).join("/");
                        return (
                            <span key={segPath} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                <span style={{ opacity: 0.4 }}>/</span>
                                <BreadcrumbLink
                                    label={seg}
                                    onClick={() => onEnterDir(segPath)}
                                    active={i === segments.length - 1}
                                />
                            </span>
                        );
                    })}
                </div>
                <div style={{ marginLeft: "auto" }}>
                    <PrimaryButton onClick={onInstall} busy={installBusy} small>
                        {installBusy ? "安装中…" : "安装此仓库"}
                    </PrimaryButton>
                </div>
            </div>

            {loading ? (
                <LoadingState />
            ) : error ? (
                <div style={{ padding: "20px 16px", color: "var(--danger)", fontFamily: MONO, fontSize: 13 }}>{error}</div>
            ) : contents?.type === "dir" ? (
                <div>
                    {contents.entries?.length === 0 ? (
                        <EmptyState quote="空目录" hint="" />
                    ) : (
                        contents.entries?.map((e) => (
                            <button
                                key={e.path}
                                onClick={() => onEnterDir(e.path)}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 12,
                                    width: "100%",
                                    padding: "11px 16px",
                                    background: "transparent",
                                    border: "none",
                                    borderTop: "1px solid var(--border)",
                                    color: "var(--foreground)",
                                    fontFamily: SANS,
                                    fontSize: 14,
                                    cursor: "pointer",
                                    textAlign: "left",
                                    transition: "background 0.15s",
                                }}
                                onMouseEnter={(ev) => (ev.currentTarget.style.background = ACCENT_SOFT)}
                                onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}
                            >
                                <span
                                    style={{
                                        fontFamily: MONO,
                                        color: e.type === "dir" ? ACCENT : "var(--muted-foreground)",
                                        width: 16,
                                        fontSize: 13,
                                    }}
                                >
                                    {e.type === "dir" ? "▸" : "·"}
                                </span>
                                <span style={{ fontWeight: e.type === "dir" ? 500 : 400, color: e.type === "dir" ? "var(--foreground)" : "var(--muted-foreground)" }}>
                                    {e.name}
                                </span>
                                {e.type === "file" && e.size > 0 && (
                                    <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--muted-foreground)", marginLeft: "auto" }}>
                                        {e.size}b
                                    </span>
                                )}
                            </button>
                        ))
                    )}
                </div>
            ) : contents?.type === "file" ? (
                <div style={{ padding: "16px" }}>
                    <div style={{ fontFamily: MONO, fontSize: 11, color: "var(--muted-foreground)", marginBottom: 10 }}>
                        {contents.path}
                    </div>
                    <pre
                        style={{
                            fontFamily: MONO,
                            fontSize: 13,
                            lineHeight: 1.6,
                            color: "var(--foreground)",
                            margin: 0,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                        }}
                    >
                        {contents.content}
                    </pre>
                </div>
            ) : null}
        </div>
    );
}

function BreadcrumbLink({ label, onClick, active }: { label: string; onClick: () => void; active?: boolean }) {
    return (
        <button
            onClick={onClick}
            style={{
                background: "none",
                border: "none",
                color: active ? "var(--foreground)" : ACCENT,
                cursor: "pointer",
                fontFamily: MONO,
                fontSize: 12,
                padding: 0,
            }}
        >
            {label}
        </button>
    );
}

/* ────────── skill preview ────────── */

function SkillPreviewView({
    skillId,
    data,
    loading,
    error,
    onBack,
}: {
    skillId: string;
    data: SkillPreview | null;
    loading: boolean;
    error: string | null;
    onBack: () => void;
}) {
    return (
        <div
            style={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: R_CARD,
                boxShadow: SHADOW_1,
                overflow: "hidden",
            }}
        >
            <div
                style={{
                    padding: "14px 18px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                }}
            >
                <SecondaryButton onClick={onBack} small>
                    ← 返回
                </SecondaryButton>
                <div style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 18, letterSpacing: "-0.01em" }}>
                    {data?.name || skillId}
                </div>
                {data?.has_code_tools && <CodeToolsBadge />}
            </div>
            {loading ? (
                <LoadingState />
            ) : error ? (
                <div style={{ padding: "20px 18px", color: "var(--danger)", fontFamily: MONO, fontSize: 13 }}>{error}</div>
            ) : data ? (
                <div style={{ padding: "18px" }}>
                    {data.description && (
                        <p style={{ fontFamily: SANS, fontSize: 14, color: "var(--muted-foreground)", margin: "0 0 16px", lineHeight: 1.55 }}>
                            {data.description}
                        </p>
                    )}
                    <SectionLabel>SKILL.md</SectionLabel>
                    <pre
                        style={{
                            fontFamily: MONO,
                            fontSize: 13,
                            lineHeight: 1.6,
                            color: "var(--foreground)",
                            background: "rgba(255,255,255,0.02)",
                            border: "1px solid var(--border)",
                            borderRadius: R_BTN,
                            padding: 14,
                            margin: "0 0 16px",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                        }}
                    >
                        {data.body || "（无 SKILL.md）"}
                    </pre>
                    <SectionLabel>文件列表（{data.files.length}）</SectionLabel>
                    <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--muted-foreground)" }}>
                        {data.files.map((f) => (
                            <div
                                key={f.path}
                                style={{
                                    padding: "6px 0",
                                    borderTop: "1px solid var(--border)",
                                    display: "flex",
                                    justifyContent: "space-between",
                                    gap: 12,
                                }}
                            >
                                <span style={{ color: "var(--foreground)", wordBreak: "break-all" }}>{f.path}</span>
                                <span style={{ opacity: 0.6, whiteSpace: "nowrap" }}>{f.size}b</span>
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <div
            style={{
                fontFamily: MONO,
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: ACCENT,
                margin: "0 0 8px",
            }}
        >
            {children}
        </div>
    );
}

/* ────────── states ────────── */

function LoadingState() {
    return (
        <div style={{ padding: "48px 0", textAlign: "center" }}>
            <motion.div
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
                style={{ fontFamily: DISPLAY, fontSize: 16, fontWeight: 500, color: "var(--muted-foreground)" }}
            >
                加载中…
            </motion.div>
        </div>
    );
}

function EmptyState({ quote, hint }: { quote: string; hint: string }) {
    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ padding: "64px 0", textAlign: "center" }}>
            <div style={{ fontFamily: DISPLAY, fontSize: 20, fontWeight: 500, color: "var(--foreground)", marginBottom: 8, letterSpacing: "-0.01em" }}>
                {quote}
            </div>
            {hint && (
                <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: "0.1em", color: "var(--muted-foreground)" }}>{hint}</div>
            )}
        </motion.div>
    );
}
