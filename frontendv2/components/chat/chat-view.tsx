"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronDown, X } from "lucide-react";
import { ChatSidebar } from "./chat-sidebar";
import { ChatHeader } from "./chat-header";
import ChatMessage from "./chat-message";
import { ChatInput, type SelectedSkill } from "./chat-input";
import { ChatSessionFiles } from "./chat-session-files";
import { ChatEmpty } from "./chat-empty";
import { SummaryModal } from "./summary-modal";
import { QuizFromSummaryDialog } from "./quiz-from-summary-dialog";
import { chatApi, quotaApi, type ChatSession, type ChatMessage as ApiChatMessage, type SessionDocument, type QuotaSummary } from "@/lib/api";
import { streamChat, artifactKey, type ChatSource, type ChatArtifact, type ChatPlan, type StreamStep, type QueueStatus, type DelegateStatus, type ChatInteraction } from "@/lib/chat-stream";
import type { ChatMessageData, ChatSessionSummary } from "./types";

// Stable empty array so `messages` doesn't change identity on every render
// (which would re-trigger the auto-scroll effect needlessly).
const EMPTY_MESSAGES: ChatMessageData[] = [];

// Local UI session shape - maps backend ChatSession + holds loaded messages.
interface UISession {
  id: string; // chat_session_id from backend
  title: string;
  lastMessageAt: string;
  messages: ChatMessageData[];
  historyLoaded: boolean;
}

function toUIMessage(m: ApiChatMessage): ChatMessageData {
  return {
    id: m.msg_id,
    role: m.role === "system" ? "assistant" : m.role,
    content: m.content,
    // Backend may return null; normalize to array.
    sources: Array.isArray(m.sources) ? m.sources : undefined,
    // 用户消息附图：MinIO 预签名 URL（新）或内联 data URL（旧消息）——不映射的话
    // 重新加载历史后图片全部消失（只在发送当轮可见）。
    images: Array.isArray(m.images) ? m.images : undefined,
    // Binary outputs (run_code images) persisted on the message; without
    // this mapping, reloading history loses the images (SSE-only display).
    artifacts: Array.isArray(m.artifacts) ? m.artifacts : undefined,
    status: m.status,
    error: m.error,
    timestamp: m.created_at,
  };
}

function toUISession(s: ChatSession): UISession {
  return {
    id: s.chat_session_id,
    title: s.title || "新对话",
    lastMessageAt: s.last_message_at || s.updated_at || s.created_at,
    messages: [],
    historyLoaded: false,
  };
}

// Client-side placeholder ids ("user-*"/"assistant-*"/"load-err") vs real
// backend msg_ids (UUIDs, used by history-loaded messages directly).
function isLocalId(id: string): boolean {
  return id.startsWith("user-") || id.startsWith("assistant-") || id === "load-err";
}

// Server addressable id of a message: serverId if backfilled, else the id
// itself when it already is a backend msg_id (history-loaded rows).
function anchorIdOf(m: ChatMessageData): string | undefined {
  if (m.serverId) return m.serverId;
  return isLocalId(m.id) ? undefined : m.id;
}

/** 升级引导横幅状态：QUOTA_EXCEEDED / COST_GUARD 时出现，下次发送时清除。 */
interface QuotaBlockInfo {
  code: string;
  message: string;
  kind?: string;
  resetAt?: number;
  upgradeSku?: string;
}

export function ChatView() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessions, setSessions] = useState<UISession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [quotaBlock, setQuotaBlock] = useState<QuotaBlockInfo | null>(null);
  // 今日用量角标（/quota/summary）：挂载时与每轮结束后刷新
  const [quotaSummary, setQuotaSummary] = useState<QuotaSummary | null>(null);

  const refreshQuota = useCallback(async () => {
    try {
      setQuotaSummary(await quotaApi.getSummary());
    } catch {
      // 用量展示是尽力而为，失败静默
    }
  }, []);

  useEffect(() => {
    void refreshQuota();
  }, [refreshQuota]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [quizDialogOpen, setQuizDialogOpen] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<SelectedSkill[]>([]);
  // Which user message is currently being edited inline (at most one).
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const messages = activeSession?.messages ?? EMPTY_MESSAGES;

  // Track which sessions have had their history fetched, so the load effect can
  // depend only on activeSessionId (not the whole sessions array, which changes
  // on every streamed token and would re-trigger the effect).
  const loadedRef = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  const updateActiveSession = useCallback((updater: (s: UISession) => UISession) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSessionId ? updater(s) : s))
    );
  }, [activeSessionId]);

  const refreshSessions = useCallback(async () => {
    try {
      const res = await chatApi.listSessions();
      const mapped = res.sessions.map(toUISession);
      // Preserve any already-loaded messages by merging on id.
      setSessions((prev) => {
        const byId = new Map(prev.map((s) => [s.id, s]));
        return mapped.map((s) => {
          const existing = byId.get(s.id);
          return existing
            ? { ...s, messages: existing.messages, historyLoaded: existing.historyLoaded }
            : s;
        });
      });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "加载会话列表失败");
    }
  }, []);

  // ---- On mount: load sessions, auto-create first one if empty ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await chatApi.listSessions();
        if (cancelled) return;
        const mapped = res.sessions.map(toUISession);
        setSessions(mapped);
        if (mapped.length > 0) {
          setActiveSessionId(mapped[0].id);
        } else {
          // No sessions exist - create the first one.
          try {
            const created = await chatApi.createSession();
            if (cancelled) return;
            const ui = toUISession(created);
            ui.historyLoaded = true; // empty, no need to fetch history
            loadedRef.current.add(ui.id);
            setSessions([ui]);
            setActiveSessionId(ui.id);
          } catch (e) {
            setLoadError(e instanceof Error ? e.message : "创建会话失败");
          }
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "加载会话列表失败");
      } finally {
        if (!cancelled) setIsLoadingSessions(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Load message history when active session changes (once per session) ----
  useEffect(() => {
    if (!activeSessionId) return;
    if (loadedRef.current.has(activeSessionId)) return;
    loadedRef.current.add(activeSessionId);

    let cancelled = false;
    (async () => {
      try {
        const res = await chatApi.getHistory(activeSessionId);
        if (cancelled) return;
        setSessions((prev) =>
          prev.map((s) =>
            s.id === activeSessionId
              ? { ...s, messages: res.messages.map(toUIMessage), historyLoaded: true }
              : s
          )
        );
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "加载历史消息失败";
        setSessions((prev) =>
          prev.map((s) =>
            s.id === activeSessionId
              ? {
                  ...s,
                  historyLoaded: true,
                  messages: [
                    {
                      id: "load-err",
                      role: "assistant",
                      content: "",
                      status: "failed",
                      error: msg,
                      timestamp: new Date().toISOString(),
                    },
                  ],
                }
              : s
          )
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  // ---- Auto-scroll with stick-to-bottom (rAF-throttled) ----
  // Follow the stream only while the user is already near the bottom; once
  // they scroll up to read, stop yanking the viewport and offer a jump-back
  // button instead.
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const scrollRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (!stickToBottomRef.current) return;
      messagesEndRef.current?.scrollIntoView({
        behavior: isStreaming ? "auto" : "smooth",
      });
    });
    return () => {
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [messages, isStreaming]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 80;
    setShowJumpToBottom(distance > 240);
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
  }, []);

  // ---- Backfill real backend msg_ids after a streamed turn ----
  // The SSE protocol carries no msg_ids, so freshly-streamed messages only
  // have local placeholder ids. Once the turn settles, pair the local list
  // with server history (same order) and record each message's real id as
  // `serverId`, which per-turn regenerate needs to truncate server history.
  // Best-effort: on any mismatch (desync) or fetch error, keep local state.
  const backfillMessageIds = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      let res = await chatApi.getHistory(activeSessionId, 1, 100);
      if (res.total > res.messages.length && res.messages.length === 100) {
        // Long session: the fresh turns sit on the last page.
        res = await chatApi.getHistory(activeSessionId, Math.ceil(res.total / 100), 100);
      }
      const server = res.messages;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== activeSessionId || server.length !== s.messages.length) return s;
          let aligned = true;
          const next = s.messages.map((m, i) => {
            const sm = server[i];
            if (sm.role !== m.role) {
              aligned = false;
              return m;
            }
            return m.id === sm.msg_id ? m : { ...m, serverId: sm.msg_id };
          });
          return aligned ? { ...s, messages: next } : s;
        })
      );
    } catch {
      // History fetch is best-effort; regenerate simply stays unavailable
      // for the affected turns until the next successful backfill.
    }
  }, [activeSessionId]);

  // ---- Core: stream a question into the active session ----
  const streamQuestion = useCallback(
    async (question: string, assistantMsgId: string, skillIds?: string[], images?: string[]) => {
      if (!activeSessionId) return;
      setIsStreaming(true);
      setQuotaBlock(null); // 新一轮开始：清掉上一轮的额度横幅
      const controller = new AbortController();
      abortRef.current = controller;

      // Throttled stream flush: SSE deltas arrive far faster than markdown
      // should be re-parsed, so the newest content/reasoning is held here and
      // committed to state at most every ~80ms (plus a final flush at the end
      // of the stream so no trailing delta is lost).
      let latestContent = "";
      let latestReasoning = "";
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let flushPending = false;

      const flushStream = () => {
        if (flushTimer != null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (!flushPending) return;
        flushPending = false;
        const content = latestContent;
        const reasoning = latestReasoning;
        updateActiveSession((s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.id === assistantMsgId ? { ...m, content, reasoning } : m
          ),
        }));
      };

      const scheduleFlush = () => {
        flushPending = true;
        if (flushTimer == null) {
          flushTimer = setTimeout(flushStream, 80);
        }
      };

      try {
        const stream = await chatApi.askStream(
          {
            question,
            chat_session_id: activeSessionId,
            ...(skillIds && skillIds.length > 0 ? { skill_ids: skillIds } : {}),
            ...(images && images.length > 0 ? { images } : {}),
          },
          controller.signal
        );

        await streamChat(
          stream,
          {
            onChunk: (accumulated) => {
              latestContent = accumulated;
              scheduleFlush();
            },
            onSources: (sources: ChatSource[]) => {
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantMsgId ? { ...m, sources } : m
                ),
              }));
            },
            onArtifact: (artifact: ChatArtifact) => {
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  const existing = m.artifacts ?? [];
                  // Structured artifacts (quiz / quiz_grading) carry no url/name — identity
                  // comes from kind + payload so replayed frames stay de-duplicated.
                  const key = artifactKey(artifact);
                  if (key && existing.some((a) => artifactKey(a) === key)) return m;
                  return { ...m, artifacts: [...existing, artifact] };
                }),
              }));
            },
            onRoute: (agent: string) => {
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantMsgId ? { ...m, agent, queuePosition: undefined } : m
                ),
              }));
            },
            onQueueStatus: ({ position }: QueueStatus) => {
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantMsgId ? { ...m, queuePosition: position } : m
                ),
              }));
            },
            onDelegate: ({ agent, status, active }: DelegateStatus) => {
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, subAgent: active > 0 ? { agent, count: active } : undefined }
                    : m
                ),
              }));
            },
            onInteract: (interaction: ChatInteraction) => {
              // ask_user 的结构化交互卡挂到本轮 assistant 消息上（answers 走
              // handleInteractionAnswer → 作为下一条普通用户消息发送）。
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantMsgId ? { ...m, interaction } : m
                ),
              }));
            },
            onPlan: (plan: ChatPlan) => {
              // Plan tool snapshot: hangs off this turn's assistant message and is
              // advanced live at each mutating step boundary. Frontend memory only.
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) => (m.id === assistantMsgId ? { ...m, plan } : m)),
              }));
            },
            onReset: () => {
              // A retried LLM run begins: clear the buffered content (the
              // backend replays pre-run content as chunks) and flush
              // immediately so no stale text lingers for up to 80ms. The plan
              // panel is turn-scoped display state too, so it clears as well;
              // a later plan mutation in the retried attempt re-emits it.
              latestContent = "";
              flushPending = true;
              flushStream();
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantMsgId ? { ...m, plan: undefined } : m
                ),
              }));
            },
            onReasoning: (accumulated) => {
              latestReasoning = accumulated;
              scheduleFlush();
            },
            onStep: (step: StreamStep) => {
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  const existing = m.reasoningSteps ?? [];
                  const idx = existing.findIndex((r) => r.step === step.step);
                  if (idx >= 0) {
                    const next = [...existing];
                    next[idx] = {
                      ...next[idx],
                      action: step.action || next[idx].action,
                      query: step.query || next[idx].query,
                      reasoning: step.reasoning || next[idx].reasoning,
                      sources: step.sources?.length ? step.sources : next[idx].sources,
                      args: step.args || next[idx].args,
                      durationMs: step.durationMs ?? next[idx].durationMs,
                    };
                    return { ...m, reasoningSteps: next };
                  }
                  return {
                    ...m,
                    reasoningSteps: [
                      ...existing,
                      {
                        step: step.step,
                        action: step.action,
                        query: step.query,
                        reasoning: step.reasoning,
                        sources: step.sources ?? [],
                        args: step.args,
                      },
                    ],
                  };
                }),
              }));
            },
            onError: (message: string, meta?: { code?: string; detail?: Record<string, unknown> }) => {
              flushStream();
              if (meta?.code === "QUOTA_EXCEEDED" || meta?.code === "COST_GUARD") {
                const detail = (meta.detail ?? {}) as { kind?: string; resetAt?: number; upgradeSku?: string };
                setQuotaBlock({
                  code: meta.code,
                  message,
                  kind: detail.kind,
                  resetAt: typeof detail.resetAt === "number" ? detail.resetAt : undefined,
                  upgradeSku: detail.upgradeSku,
                });
              } else {
                setQuotaBlock(null);
              }
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantMsgId ? { ...m, status: "failed", error: message } : m
                ),
              }));
            },
            onComplete: () => {
              flushStream();
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantMsgId && m.status === "pending" ? { ...m, status: "completed" } : m
                ),
              }));
            },
          },
          controller.signal
        );

        // Refresh session list (title may be auto-generated by backend)
        refreshSessions();
      } catch (error) {
        // Aborted by user (stop) - not an error; handleStop already finalized the msg.
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        flushStream();
        const message = error instanceof Error ? error.message : "请求失败";
        updateActiveSession((s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.id === assistantMsgId ? { ...m, status: "failed", error: message } : m
          ),
        }));
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
        void backfillMessageIds();
        void refreshQuota();
      }
    },
    [activeSessionId, updateActiveSession, refreshSessions, backfillMessageIds]
  );

  // ---- Send a message (skillIds: forced-inject skills for this turn only) ----
  const handleSend = useCallback(
    (userMessage: string, skillIds?: string[], images?: string[]) => {
      if (!activeSessionId) return;

      const userMsgId = `user-${Date.now()}`;
      const assistantMsgId = `assistant-${Date.now() + 1}`;
      const timestamp = new Date().toISOString();

      updateActiveSession((s) => ({
        ...s,
        lastMessageAt: timestamp,
        messages: [
          ...s.messages,
          {
            id: userMsgId,
            role: "user",
            content: userMessage,
            images: images && images.length > 0 ? images : undefined,
            status: "completed",
            timestamp,
          },
          { id: assistantMsgId, role: "assistant", content: "", status: "pending", timestamp },
        ],
      }));

      void streamQuestion(userMessage, assistantMsgId, skillIds, images);
      // Skills are per-turn (Claude-Code-style): consumed by this message.
      if (skillIds && skillIds.length > 0) setSelectedSkills([]);
    },
    [activeSessionId, updateActiveSession, streamQuestion]
  );

  // ---- Answer an AI interaction card (ask_user) ----
  // Backend is round-based: the normalized answer (chip value / form fields)
  // is sent as the NEXT ORDINARY user message; the card then renders settled.
  const handleInteractionAnswer = useCallback(
    (assistantMsgId: string, answer: string) => {
      if (isStreaming || !answer.trim()) return;
      updateActiveSession((s) => ({
        ...s,
        messages: s.messages.map((m) =>
          m.id === assistantMsgId ? { ...m, interactionAnswered: true } : m
        ),
      }));
      handleSend(answer);
    },
    [isStreaming, updateActiveSession, handleSend]
  );

  // ---- Slash-menu skill toggle (chips above the input) ----
  const handleToggleSkill = useCallback((skill: SelectedSkill) => {
    setSelectedSkills((prev) =>
      prev.some((s) => s.skill_id === skill.skill_id)
        ? prev.filter((s) => s.skill_id !== skill.skill_id)
        : [...prev, skill]
    );
  }, []);

  // ---- Regenerate a specific turn (per-turn rewrite) ----
  // Truncates server history from the turn's user message onward (the turn
  // itself and everything after it), then re-asks that question. Requires
  // the turn to be server-addressable (real msg_id backfilled from history).
  const handleRegenerate = useCallback(
    async (assistantMsgId: string) => {
      if (!activeSessionId || isStreaming) return;
      const sess = sessions.find((s) => s.id === activeSessionId);
      if (!sess) return;
      const idx = sess.messages.findIndex((m) => m.id === assistantMsgId);
      if (idx < 1) return;
      const prevUser = sess.messages[idx - 1];
      if (prevUser.role !== "user") return;
      const anchorId = anchorIdOf(prevUser);
      if (!anchorId) return;

      try {
        await chatApi.truncateHistoryFrom(activeSessionId, anchorId);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "重写失败，请稍后重试");
        return;
      }

      const timestamp = new Date().toISOString();
      const userMsgId = `user-${Date.now()}`;
      const newAssistantId = `assistant-${Date.now() + 1}`;
      updateActiveSession((s) => ({
        ...s,
        messages: [
          ...s.messages.slice(0, idx - 1),
          {
            id: userMsgId,
            role: "user",
            content: prevUser.content,
            status: "completed",
            timestamp,
          },
          {
            id: newAssistantId,
            role: "assistant",
            content: "",
            status: "pending",
            timestamp,
          },
        ],
      }));
      void streamQuestion(prevUser.content, newAssistantId);
    },
    [activeSessionId, isStreaming, sessions, updateActiveSession, streamQuestion]
  );

  // ---- Edit a user message (ChatGPT-style rewrite from that turn) ----
  // Truncates server history from the edited user message (inclusive), then
  // re-asks with the new content. Requires a server-addressable msg_id.
  const handleEditUserMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!activeSessionId || isStreaming) return;
      const content = newContent.trim();
      if (!content) return;
      const sess = sessions.find((s) => s.id === activeSessionId);
      if (!sess) return;
      const idx = sess.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      const target = sess.messages[idx];
      if (target.role !== "user" || content === target.content) return;
      const anchorId = anchorIdOf(target);
      if (!anchorId) return;

      try {
        await chatApi.truncateHistoryFrom(activeSessionId, anchorId);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "编辑失败，请稍后重试");
        return;
      }

      const timestamp = new Date().toISOString();
      const userMsgId = `user-${Date.now()}`;
      const assistantMsgId = `assistant-${Date.now() + 1}`;
      updateActiveSession((s) => ({
        ...s,
        messages: [
          ...s.messages.slice(0, idx),
          {
            id: userMsgId,
            role: "user",
            content,
            status: "completed",
            timestamp,
          },
          {
            id: assistantMsgId,
            role: "assistant",
            content: "",
            status: "pending",
            timestamp,
          },
        ],
      }));
      void streamQuestion(content, assistantMsgId);
    },
    [activeSessionId, isStreaming, sessions, updateActiveSession, streamQuestion]
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
    updateActiveSession((s) => ({
      ...s,
      messages: s.messages.map((m) => {
        if (m.status !== "pending") return m;
        // A stop with nothing streamed leaves a blank bubble; surface it as
        // an explicit failure so the user sees what happened and can retry.
        return m.content
          ? { ...m, status: "completed" }
          : { ...m, status: "failed", error: "已停止生成" };
      }),
    }));
  }, [updateActiveSession]);

  // ---- 图片灯箱(点击消息缩略图看大图;Esc/点击遮罩关闭) ----
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!lightboxSrc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxSrc(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxSrc]);

  // ---- Session files (documents uploaded into the current chat) ----
  const [sessionFiles, setSessionFiles] = useState<SessionDocument[]>([]);
  const refreshSessionFiles = useCallback(async (sessionId: string) => {
    try {
      const res = await chatApi.listDocuments(sessionId);
      setSessionFiles(res.documents ?? []);
    } catch {
      // 列表失败不打断聊天（无文件显示 = 不可用降级）
      setSessionFiles([]);
    }
  }, []);
  useEffect(() => {
    if (activeSessionId) void refreshSessionFiles(activeSessionId);
    else setSessionFiles([]);
  }, [activeSessionId, refreshSessionFiles]);

  const handleAttachDocuments = useCallback(
    async (files: File[]) => {
      // 无会话时先建一个（对齐 handleNewChat），否则上传没有归属
      let sessionId = activeSessionId;
      if (!sessionId) {
        try {
          const res = await chatApi.createSession();
          const ui = toUISession(res);
          ui.historyLoaded = true;
          loadedRef.current.add(ui.id);
          setSessions((prev) => [ui, ...prev]);
          setActiveSessionId(res.chat_session_id);
          sessionId = res.chat_session_id;
        } catch (e) {
          setLoadError(e instanceof Error ? e.message : "创建会话失败");
          return;
        }
      }
      const failed: string[] = [];
      for (const file of files) {
        try {
          await chatApi.uploadDocument(file, sessionId);
        } catch (e) {
          failed.push(`${file.name}（${e instanceof Error ? e.message : "上传失败"}）`);
        }
      }
      if (failed.length > 0) {
        setLoadError(`上传失败：${failed.join("、")}`);
      }
      void refreshSessionFiles(sessionId);
    },
    [activeSessionId, refreshSessionFiles]
  );

  const handleDeleteSessionFile = useCallback(
    async (doc: SessionDocument) => {
      if (!activeSessionId) return;
      try {
        await chatApi.deleteDocument(activeSessionId, doc.id);
        setSessionFiles((prev) => prev.filter((f) => f.id !== doc.id));
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "删除文件失败");
      }
    },
    [activeSessionId]
  );

  // ---- New chat: create backend session ----
  const handleNewChat = useCallback(async () => {
    try {
      const res = await chatApi.createSession();
      const ui = toUISession(res);
      ui.historyLoaded = true;
      loadedRef.current.add(ui.id);
      setSessions((prev) => [ui, ...prev]);
      setActiveSessionId(res.chat_session_id);
      setEditingMessageId(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "创建会话失败");
    }
  }, []);

  const handleSessionSelect = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    // Fresh session view starts pinned to the bottom.
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    setEditingMessageId(null);
    // 桌面端（md+，≥768px）侧边栏常驻，选中会话不能把它收起变窄；
    // 仅移动端覆盖式抽屉需要选中后自动关闭。
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches
    ) {
      setSidebarOpen(false);
    }
  }, []);

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await chatApi.deleteSession(sessionId);
        loadedRef.current.delete(sessionId);
        setSessions((prev) => {
          const next = prev.filter((s) => s.id !== sessionId);
          if (activeSessionId === sessionId) {
            setActiveSessionId(next[0]?.id ?? null);
          }
          return next;
        });
        // If we deleted the last session, create a fresh one.
        if (sessions.length <= 1) {
          const created = await chatApi.createSession();
          const ui = toUISession(created);
          ui.historyLoaded = true;
          loadedRef.current.add(ui.id);
          setSessions([ui]);
          setActiveSessionId(created.chat_session_id);
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "删除会话失败");
      }
    },
    [activeSessionId, sessions.length]
  );

  const handleRenameSession = useCallback(
    async (sessionId: string, newTitle: string) => {
      try {
        await chatApi.updateSession(sessionId, { title: newTitle });
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, title: newTitle } : s))
        );
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "重命名会话失败");
      }
    },
    []
  );

  const handleClearChat = useCallback(() => {
    if (!activeSessionId) return;
    updateActiveSession((s) => ({ ...s, messages: [] }));
  }, [activeSessionId, updateActiveSession]);

  // ---- ⌘N / Ctrl+N: new chat ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void handleNewChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleNewChat]);

  const sidebarSessions: ChatSessionSummary[] = isLoadingSessions
    ? []
    : sessions.map((s) => ({ id: s.id, title: s.title, lastMessageAt: s.lastMessageAt }));

  return (
    <div className="relative flex h-[100dvh] w-full overflow-hidden">
      <ChatSidebar
        sessions={sidebarSessions}
        activeSessionId={activeSessionId ?? undefined}
        onSessionSelect={handleSessionSelect}
        onNewChat={handleNewChat}
        onDeleteSession={handleDeleteSession}
        onRenameSession={handleRenameSession}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="relative flex min-w-0 flex-1 flex-col">
        <ChatHeader
          title={activeSession?.title ?? "MindBase"}
          hasMessages={messages.length > 0}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onClearChat={handleClearChat}
          onSummarize={() => setSummaryOpen(true)}
        />

        {loadError && (
          <div className="border-b border-danger/10 bg-danger/5 px-4 py-2 text-[12px] text-danger">
            {loadError}
          </div>
        )}

        {/* Messages scroll area */}
        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto">
            {messages.length === 0 ? (
              <ChatEmpty onSuggestionClick={handleSend} />
            ) : (
              <div className="mx-auto max-w-[768px] space-y-5 px-5 py-6">
                {messages.map((message, i) => {
                  const prev = messages[i - 1];
                  const regenAnchor =
                    prev && prev.role === "user" ? anchorIdOf(prev) : undefined;
                  const canRegenerate =
                    message.role === "assistant" &&
                    (message.status === "completed" || message.status === "failed") &&
                    !!regenAnchor;
                  const editAnchor =
                    message.role === "user" ? anchorIdOf(message) : undefined;
                  const canEdit = !isStreaming && !!editAnchor;
                  return (
                    <ChatMessage
                      key={message.id}
                      role={message.role}
                      content={message.content}
                      images={message.images}
                      onImageOpen={setLightboxSrc}
                      sources={message.sources}
                      artifacts={message.artifacts}
                      reasoningSteps={message.reasoningSteps}
                      reasoning={message.reasoning}
                      agent={message.agent}
                      queuePosition={message.queuePosition}
                      subAgent={message.subAgent}
                      interaction={message.interaction}
                      interactionAnswered={message.interactionAnswered}
                      plan={message.plan}
                      onInteractionAnswer={
                        message.interaction && !message.interactionAnswered && !isStreaming
                          ? (answer: string) => handleInteractionAnswer(message.id, answer)
                          : undefined
                      }
                      status={message.status}
                      error={message.error}
                      timestamp={message.timestamp}
                      onRegenerate={
                        canRegenerate
                          ? () => void handleRegenerate(message.id)
                          : undefined
                      }
                      onEdit={canEdit ? () => setEditingMessageId(message.id) : undefined}
                      isEditing={editingMessageId === message.id}
                      onEditSubmit={(content) => {
                        setEditingMessageId(null);
                        void handleEditUserMessage(message.id, content);
                      }}
                      onEditCancel={() => setEditingMessageId(null)}
                    />
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Jump back to the live bottom when the user scrolled up */}
          {showJumpToBottom && (
            <button
              type="button"
              onClick={() => scrollToBottom()}
              className="absolute bottom-4 left-1/2 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-full border border-border-subtle bg-surface text-secondary shadow-sm transition-colors hover:text-foreground"
              aria-label="回到底部"
            >
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Input area - bottom padding keeps clear of the iOS home indicator */}
        <div className="shrink-0 px-5 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto max-w-[768px]">
            {(() => {
              const chatKind = quotaSummary?.enabled
                ? quotaSummary.kinds.find((k) => k.kind === "chat")
                : undefined;
              if (!chatKind || chatKind.limit < 0) return null;
              const ratio = chatKind.limit > 0 ? chatKind.used / chatKind.limit : 0;
              return (
                <div className="mb-1 flex justify-end px-1 text-xs text-secondary">
                  今日 AI 问答 {chatKind.used}/{chatKind.limit}
                  {ratio >= 0.8 ? " · 额度即将用完" : ""}
                </div>
              );
            })()}
            {quotaBlock && (
              <div
                role="alert"
                className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface px-4 py-3 text-sm shadow-sm"
              >
                <div>
                  <p className="font-medium text-foreground">{quotaBlock.message}</p>
                  <p className="mt-0.5 text-xs text-secondary">
                    {quotaBlock.resetAt
                      ? `重置时间：${new Date(quotaBlock.resetAt).toLocaleString()} · `
                      : ""}
                    升级会员可获得更高每日额度与会员优先队列
                  </p>
                </div>
                <a
                  href="/membership"
                  className="shrink-0 rounded-lg bg-[#1f2329] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
                >
                  升级会员
                </a>
              </div>
            )}
            <ChatSessionFiles files={sessionFiles} onDelete={handleDeleteSessionFile} />
            <ChatInput
              onSend={handleSend}
              disabled={isStreaming || !activeSessionId}
              isStreaming={isStreaming}
              onStop={handleStop}
              selectedSkills={selectedSkills}
              onToggleSkill={handleToggleSkill}
              onOpenQuizWizard={() => setQuizDialogOpen(true)}
              onAttachDocuments={handleAttachDocuments}
            />
          </div>
        </div>
      </main>

      {lightboxSrc && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="图片预览"
          className="fixed inset-0 z-[9998] flex cursor-zoom-out items-center justify-center bg-black/80 p-6 md:p-10"
          onClick={() => setLightboxSrc(null)}
        >
          <img
            src={lightboxSrc}
            alt="图片预览"
            className="max-h-full max-w-full rounded-xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setLightboxSrc(null)}
            aria-label="关闭预览"
            className="absolute right-5 top-5 grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      )}

      <SummaryModal
        open={summaryOpen}
        onClose={() => setSummaryOpen(false)}
        chatSessionId={activeSessionId}
      />

      <QuizFromSummaryDialog
        open={quizDialogOpen}
        onClose={() => setQuizDialogOpen(false)}
        chatSessionId={activeSessionId}
      />
    </div>
  );
}
