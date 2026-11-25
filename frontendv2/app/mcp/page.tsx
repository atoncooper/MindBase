"use client";

import { useEffect, useState } from "react";
import { NavBar } from "@/components/nav-bar";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { mcpApi, type McpAuthKind, type UserMcpServer } from "@/lib/api";
import { CheckCircle2, KeyRound, Loader2, Pencil, Plug, Plus, RefreshCw, ShieldCheck, Trash2, XCircle } from "lucide-react";

const AUTH_OPTIONS: Array<{ value: McpAuthKind; label: string; hint: string }> = [
    { value: "none", label: "无需鉴权", hint: "公开可访问的 MCP Server" },
    { value: "bearer", label: "API Key", hint: "以 Authorization: Bearer <key> 发送" },
    { value: "header", label: "自定义 Header", hint: "以指定 Header 名发送 API Key" },
    { value: "oauth", label: "OAuth 授权", hint: "跳转第三方账号授权（Notion / Linear 等）" },
];

const EMPTY_FORM = { name: "", url: "", authKind: "none" as McpAuthKind, apiKey: "", authHeader: "" };

export default function McpPage() {
    const [servers, setServers] = useState<UserMcpServer[]>([]);
    const [enabled, setEnabled] = useState(true);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<UserMcpServer | null>(null);
    const [deleting, setDeleting] = useState(false);

    async function load() {
        setLoading(true);
        setError("");
        try {
            const data = await mcpApi.list();
            setServers(data.servers);
            setEnabled(data.enabled);
        } catch (err) {
            setError(err instanceof Error ? err.message : "MCP 配置加载失败");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        void load();
        // The OAuth callback redirects back here with ?oauth=ok|error.
        const params = new URLSearchParams(window.location.search);
        const status = params.get("oauth");
        if (!status) return;
        if (status === "ok") {
            setNotice("授权成功，已连接 MCP Server。");
            const serverId = Number(params.get("server"));
            if (Number.isInteger(serverId) && serverId > 0) {
                // Authorization just completed: discover its tools right away.
                void testServer(serverId);
            }
        } else {
            setError("授权失败：" + (params.get("message") || "未知错误"));
        }
        window.history.replaceState({}, "", window.location.pathname);
    }, []);

    function openCreate() {
        setEditingId(null);
        setForm(EMPTY_FORM);
        setFormMode("create");
        setError("");
        setNotice("");
        window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function openEdit(server: UserMcpServer) {
        setEditingId(server.id);
        setForm({
            name: server.name,
            url: server.url,
            authKind: server.auth_kind,
            apiKey: "",
            authHeader: server.auth_header ?? "",
        });
        setFormMode("edit");
        setError("");
        setNotice("");
        window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function closeForm() {
        setFormMode(null);
        setEditingId(null);
        setForm(EMPTY_FORM);
    }

    async function startOAuth(id: number) {
        setBusy("auth:" + id);
        setError("");
        try {
            const { authorization_url } = await mcpApi.startOAuth(id);
            window.location.assign(authorization_url);
        } catch (err) {
            setError(err instanceof Error ? err.message : "发起授权失败");
            setBusy("");
        }
    }

    async function submitForm() {
        setSaving(true);
        setError("");
        setNotice("");
        try {
            if (formMode === "edit" && editingId !== null) {
                await saveEdit(editingId);
                return;
            }
            const { server } = await mcpApi.create({
                name: form.name,
                url: form.url,
                auth_kind: form.authKind,
                ...(form.authKind === "none" || form.authKind === "oauth" ? {} : { api_key: form.apiKey }),
                ...(form.authKind === "header" ? { auth_header: form.authHeader } : {}),
            });
            setServers((prev) => [...prev, server]);
            closeForm();
            if (server.auth_kind === "oauth") {
                await startOAuth(server.id);
                return;
            }
            // Discovery is a separate app-ts step; a failed probe keeps the
            // saved connection and records last_error instead of losing input.
            await testServer(server.id);
        } catch (err) {
            setError(err instanceof Error ? err.message : "保存 MCP 失败");
        } finally {
            setSaving(false);
        }
    }

    async function saveEdit(id: number) {
        const previous = servers.find((s) => s.id === id);
        const { server } = await mcpApi.update(id, {
            name: form.name,
            url: form.url,
            auth_kind: form.authKind,
            ...(needsKey && form.apiKey.trim() ? { api_key: form.apiKey } : {}),
            ...(form.authKind === "header" ? { auth_header: form.authHeader } : {}),
        });
        setServers((prev) => prev.map((s) => (s.id === id ? { ...s, ...server } : s)));
        const authChanged = !!previous && (previous.url !== server.url || previous.auth_kind !== server.auth_kind);
        closeForm();
        if (server.auth_kind === "oauth" && !server.oauth_authorized) {
            await startOAuth(server.id);
            return;
        }
        if (authChanged) {
            await testServer(server.id);
        }
    }

    async function testServer(id: number) {
        setBusy("test:" + id);
        setError("");
        setNotice("");
        try {
            const updated = await mcpApi.discover(id);
            setServers((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)));
        } catch (err) {
            setError(err instanceof Error ? err.message : "连接测试失败");
            await load();
        } finally {
            setBusy("");
        }
    }

    async function toggleServer(server: UserMcpServer) {
        setBusy("toggle:" + server.id);
        setError("");
        try {
            const { server: updated } = await mcpApi.update(server.id, { enabled: !server.enabled });
            setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        } catch (err) {
            setError(err instanceof Error ? err.message : "更新失败");
        } finally {
            setBusy("");
        }
    }

    async function confirmDelete() {
        if (!pendingDelete) return;
        setDeleting(true);
        setError("");
        try {
            await mcpApi.remove(pendingDelete.id);
            setServers((prev) => prev.filter((s) => s.id !== pendingDelete.id));
            setPendingDelete(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "删除失败");
        } finally {
            setDeleting(false);
        }
    }

    const needsKey = form.authKind === "bearer" || form.authKind === "header";
    const editingServer = formMode === "edit" ? servers.find((s) => s.id === editingId) : undefined;
    // Editing an existing keyed connection may keep the stored key (blank = keep).
    const keySatisfied =
        !needsKey || (!!editingServer?.api_key_masked && form.apiKey.trim() === "") || form.apiKey.trim().length > 0;
    const canSubmit =
        !saving &&
        form.name.trim().length > 0 &&
        form.url.trim().length > 0 &&
        keySatisfied &&
        (form.authKind !== "header" || form.authHeader.trim().length > 0);

    const formTitle = formMode === "edit" ? "编辑 MCP Server" : "添加 MCP Server";

    return (
        <>
            <NavBar />
            <main className="min-h-[calc(100dvh-3rem)] bg-[#f8f9fa]">
                <div className="mx-auto w-full max-w-[980px] px-5 py-8 sm:px-8 sm:py-10">
                    <header className="flex flex-wrap items-end justify-between gap-4">
                        <div>
                            <p className="flex items-center gap-1.5 text-[12px] text-[#5f6368]">
                                <Plug className="h-3.5 w-3.5 text-[#0b57d0]" />
                                Harness 扩展
                            </p>
                            <h1 className="mt-2 text-[26px] font-medium leading-8 text-[#202124]">MCP 接入</h1>
                            <p className="mt-1 max-w-[660px] text-[13px] leading-relaxed text-[#5f6368]">
                                连接你自己的第三方 MCP Server。连接只对当前账号生效，Agent 可以在对话中自动调用这些工具。
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => (formMode === "create" ? closeForm() : openCreate())}
                            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[#0b57d0] px-3.5 text-[12px] font-medium text-white transition-colors hover:bg-[#0a4cb5]"
                        >
                            <Plus className="h-3.5 w-3.5" />
                            添加 MCP
                        </button>
                    </header>

                    {formMode !== null && (
                        <section className="mt-6 rounded-xl border border-[#dadce0] bg-white p-5 sm:p-6">
                            <h2 className="text-[15px] font-medium text-[#202124]">{formTitle}</h2>
                            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                                <label className="block text-[12px] text-[#5f6368]">
                                    名称
                                    <input
                                        className="mt-1 h-10 w-full rounded-md border border-[#dadce0] px-3 text-[13px] text-[#202124] outline-none focus:border-[#0b57d0]"
                                        value={form.name}
                                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                                        placeholder="例如 notion"
                                    />
                                </label>
                                <label className="block text-[12px] text-[#5f6368]">
                                    MCP URL
                                    <input
                                        className="mt-1 h-10 w-full rounded-md border border-[#dadce0] px-3 font-mono text-[12px] text-[#202124] outline-none focus:border-[#0b57d0]"
                                        value={form.url}
                                        onChange={(e) => setForm({ ...form, url: e.target.value })}
                                        placeholder="https://mcp.example.com/mcp"
                                    />
                                </label>
                            </div>
                            <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                <label className="block text-[12px] text-[#5f6368]">
                                    鉴权方式
                                    <select
                                        className="mt-1 h-10 w-full rounded-md border border-[#dadce0] bg-white px-3 text-[13px] text-[#202124] outline-none focus:border-[#0b57d0]"
                                        value={form.authKind}
                                        onChange={(e) => setForm({ ...form, authKind: e.target.value as McpAuthKind })}
                                    >
                                        {AUTH_OPTIONS.map((opt) => (
                                            <option key={opt.value} value={opt.value}>
                                                {opt.label}
                                            </option>
                                        ))}
                                    </select>
                                    <span className="mt-1 block text-[11px] text-[#80868b]">
                                        {AUTH_OPTIONS.find((o) => o.value === form.authKind)?.hint}
                                    </span>
                                </label>
                                {form.authKind === "header" && (
                                    <label className="block text-[12px] text-[#5f6368]">
                                        Header 名称
                                        <input
                                            className="mt-1 h-10 w-full rounded-md border border-[#dadce0] px-3 font-mono text-[12px] text-[#202124] outline-none focus:border-[#0b57d0]"
                                            value={form.authHeader}
                                            onChange={(e) => setForm({ ...form, authHeader: e.target.value })}
                                            placeholder="X-API-Key"
                                        />
                                    </label>
                                )}
                            </div>
                            {needsKey && (
                                <label className="mt-3 block text-[12px] text-[#5f6368]">
                                    API Key
                                    <input
                                        type="password"
                                        autoComplete="off"
                                        className="mt-1 h-10 w-full rounded-md border border-[#dadce0] px-3 font-mono text-[12px] text-[#202124] outline-none focus:border-[#0b57d0]"
                                        value={form.apiKey}
                                        onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                                        placeholder={
                                            editingServer?.api_key_masked
                                                ? "留空表示不修改已保存的 Key"
                                                : "粘贴 MCP Server 提供的 API Key"
                                        }
                                    />
                                    <span className="mt-1 block text-[11px] text-[#80868b]">
                                        加密存储，保存后不再回显；仅你的 Agent 调用时使用。
                                    </span>
                                </label>
                            )}
                            {form.authKind === "oauth" && (
                                <div className="mt-3 rounded-md border border-[#e8eaed] bg-[#f8f9fa] px-3 py-2 text-[12px] leading-5 text-[#5f6368]">
                                    保存后会跳转到第三方授权页（OAuth 2.1 + PKCE）。授权完成后自动回到本页，无需填写 Key。
                                    {formMode === "edit" && editingServer?.oauth_authorized
                                        ? " 修改 URL 会使现有授权失效，需要重新授权。"
                                        : ""}
                                </div>
                            )}
                            <div className="mt-4 flex items-center justify-end gap-2">
                                <button
                                    type="button"
                                    onClick={closeForm}
                                    className="h-9 rounded-md border border-[#dadce0] px-3 text-[12px] text-[#3c4043] hover:bg-[#f1f3f4]"
                                >
                                    取消
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void submitForm()}
                                    disabled={!canSubmit}
                                    className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[#0b57d0] px-3.5 text-[12px] font-medium text-white disabled:opacity-50"
                                >
                                    {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                    {formMode === "edit" ? "保存" : form.authKind === "oauth" ? "保存并授权" : "连接并保存"}
                                </button>
                            </div>
                            <p className="mt-3 text-[11px] leading-5 text-[#80868b]">
                                保存后会执行一次 tools/list；连接失败不会丢掉已保存的配置，可以稍后点「测试」重试。
                            </p>
                        </section>
                    )}

                    {notice && (
                        <div className="mt-5 rounded-xl border border-[#b7e1cd] bg-[#e6f4ea] px-4 py-3 text-[13px] text-[#137333]">
                            {notice}
                        </div>
                    )}
                    {error && (
                        <div className="mt-5 rounded-xl border border-[#f3c7c4] bg-[#fce8e6] px-4 py-3 text-[13px] text-[#c5221f]">
                            {error}
                        </div>
                    )}

                    {!enabled && (
                        <div className="mt-5 rounded-xl border border-[#f6d9a8] bg-[#fef7e0] px-4 py-3 text-[13px] text-[#8a5a00]">
                            用户 MCP 功能当前被服务端关闭。
                        </div>
                    )}

                    {loading ? (
                        <div className="mt-8 flex items-center gap-2 text-[13px] text-[#5f6368]">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            正在读取你的 MCP 连接…
                        </div>
                    ) : (
                        <div className="mt-6 grid gap-4">
                            {servers.length === 0 && (
                                <section className="rounded-xl border border-[#dadce0] bg-white p-8 text-center">
                                    <Plug className="mx-auto h-7 w-7 text-[#0b57d0]" />
                                    <h2 className="mt-3 text-[15px] font-medium text-[#202124]">还没有 MCP 连接</h2>
                                    <p className="mt-1 text-[13px] text-[#5f6368]">添加一个你自己的 MCP Server，Agent 就能在对话中调用它。</p>
                                </section>
                            )}
                            {servers.map((server) => {
                                const isOAuth = server.auth_kind === "oauth";
                                const canTest = !isOAuth || !!server.oauth_authorized;
                                return (
                                    <section key={server.id} className="rounded-xl border border-[#dadce0] bg-white p-5 sm:p-6">
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <h2 className="text-[15px] font-medium text-[#202124]">{server.name}</h2>
                                                    {server.tools.length > 0 ? (
                                                        <span className="inline-flex items-center gap-1 rounded-full bg-[#e6f4ea] px-2 py-0.5 text-[11px] text-[#188038]">
                                                            <CheckCircle2 className="h-3 w-3" /> 已连接
                                                        </span>
                                                    ) : (
                                                        <span className="inline-flex items-center gap-1 rounded-full bg-[#f1f3f4] px-2 py-0.5 text-[11px] text-[#5f6368]">
                                                            <XCircle className="h-3 w-3" /> 未发现工具
                                                        </span>
                                                    )}
                                                    {isOAuth ? (
                                                        <span
                                                            className={
                                                                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] " +
                                                                (server.oauth_authorized
                                                                    ? "bg-[#e6f4ea] text-[#188038]"
                                                                    : "bg-[#fef7e0] text-[#8a5a00]")
                                                            }
                                                        >
                                                            <ShieldCheck className="h-3 w-3" />
                                                            {server.oauth_authorized ? "OAuth 已授权" : "OAuth 未授权"}
                                                        </span>
                                                    ) : server.auth_kind !== "none" ? (
                                                        <span className="inline-flex items-center gap-1 rounded-full bg-[#f1f3f4] px-2 py-0.5 text-[11px] text-[#5f6368]">
                                                            <KeyRound className="h-3 w-3" />
                                                            {server.api_key_masked ? server.api_key_masked : "已保存 API Key"}
                                                        </span>
                                                    ) : null}
                                                </div>
                                                <p className="mt-1.5 truncate font-mono text-[11.5px] text-[#80868b]">{server.url}</p>
                                                {server.oauth_issuer && (
                                                    <p className="mt-0.5 truncate text-[11px] text-[#80868b]">授权服务器：{server.oauth_issuer}</p>
                                                )}
                                                {server.last_error && <p className="mt-1 text-[11px] text-[#c5221f]">{server.last_error}</p>}
                                            </div>
                                            <div className="flex shrink-0 items-center gap-1.5">
                                                {isOAuth && (
                                                    <button
                                                        type="button"
                                                        onClick={() => void startOAuth(server.id)}
                                                        disabled={busy === "auth:" + server.id}
                                                        className="inline-flex h-8 items-center gap-1 rounded-md bg-[#0b57d0] px-2.5 text-[11px] text-white hover:bg-[#0a4cb5] disabled:opacity-50"
                                                    >
                                                        {busy === "auth:" + server.id ? (
                                                            <Loader2 className="h-3 w-3 animate-spin" />
                                                        ) : (
                                                            <ShieldCheck className="h-3 w-3" />
                                                        )}
                                                        {server.oauth_authorized ? "重新授权" : "授权"}
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => void testServer(server.id)}
                                                    disabled={busy === "test:" + server.id || !canTest}
                                                    title={canTest ? undefined : "请先完成 OAuth 授权"}
                                                    className="inline-flex h-8 items-center gap-1 rounded-md border border-[#dadce0] px-2.5 text-[11px] text-[#3c4043] hover:bg-[#f1f3f4] disabled:opacity-50"
                                                >
                                                    <RefreshCw className={busy === "test:" + server.id ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
                                                    测试
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => openEdit(server)}
                                                    className="inline-flex h-8 items-center gap-1 rounded-md border border-[#dadce0] px-2.5 text-[11px] text-[#3c4043] hover:bg-[#f1f3f4]"
                                                >
                                                    <Pencil className="h-3 w-3" />
                                                    编辑
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => void toggleServer(server)}
                                                    disabled={busy === "toggle:" + server.id}
                                                    className="h-8 rounded-md border border-[#dadce0] px-2.5 text-[11px] text-[#3c4043] hover:bg-[#f1f3f4] disabled:opacity-50"
                                                >
                                                    {server.enabled ? "停用" : "启用"}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setPendingDelete(server)}
                                                    disabled={busy === "delete:" + server.id}
                                                    className="grid h-8 w-8 place-items-center rounded-md text-[#80868b] hover:bg-[#fce8e6] hover:text-[#c5221f] disabled:opacity-50"
                                                    aria-label="删除 MCP"
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </button>
                                            </div>
                                        </div>
                                        <div className="mt-4 flex flex-wrap gap-1.5">
                                            {server.tools.map((tool) => (
                                                <code key={tool.name} className="rounded-md border border-[#e8eaed] bg-[#f8f9fa] px-2 py-1 font-mono text-[11px] text-[#3c4043]">
                                                    {tool.name}
                                                </code>
                                            ))}
                                        </div>
                                    </section>
                                );
                            })}
                        </div>
                    )}

                    <section className="mt-6 rounded-xl border border-[#dadce0] bg-white p-5 text-[12px] leading-6 text-[#5f6368] sm:p-6">
                        <h2 className="text-[14px] font-medium text-[#202124]">Agent 如何调用</h2>
                        <p className="mt-1">
                            你的 MCP 工具目录会按当前登录用户注入主 Agent 的系统提示词。Agent 通过 mcp_user_call 调用，不会看到其他用户的连接；
                            凭据（API Key 或 OAuth token）只用于你配置的 MCP Server，与平台 AI 能力无关。
                        </p>
                    </section>
                </div>
            </main>

            <ConfirmDialog
                open={pendingDelete !== null}
                danger
                title="删除 MCP 连接"
                message={
                    pendingDelete
                        ? `确定删除「${pendingDelete.name}」？删除后 Agent 将不再能调用它的工具。`
                        : undefined
                }
                confirmLabel="删除"
                busy={deleting}
                onCancel={() => {
                    if (!deleting) setPendingDelete(null);
                }}
                onConfirm={() => void confirmDelete()}
            />
        </>
    );
}
