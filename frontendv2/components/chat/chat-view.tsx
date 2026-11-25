"use client";

import { memo, useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, FileText, FlaskConical, Loader2, X } from "lucide-react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ChatSidebar } from "./chat-sidebar";
import { ChatHeader } from "./chat-header";
import ChatMessage from "./chat-message";
import { ChatInput, type SelectedSkill } from "./chat-input";
import type { ChatModelSelection } from "./chat-model-picker";
import { QueuedMessages, type QueuedMessage } from "./queued-messages";
import { ChatEmpty } from "./chat-empty";
import { SummaryModal } from "./summary-modal";
import { QuizFromSummaryDialog } from "./quiz-from-summary-dialog";
import { academicApi, chatApi, quotaApi, type AcademicProjectSummary, type ChatModel, type ChatSession, type ChatMessage as ApiChatMessage, type SessionDocument, type QuotaSummary } from "@/lib/api";
import { STAGE_LABELS } from "@/components/research/research-ui";

import { streamChat, artifactKey, type ChatSource, type ChatArtifact, type ChatPlan, type StreamStep, type QueueStatus, type DelegateStatus, type ChatInteraction } from "@/lib/chat-stream";
import type { ChatMessageData, ChatSessionSummary } from "./types";

// 用户自选的聊天模型（GET /chat/models 的 id）；"" / 无值 = 服务端默认模型。
const CHAT_MODEL_STORAGE_KEY = "mindbase.chat.model";

/** /chat/history 单页条数（后端 page_size 上限 100，50 兼顾首屏与 DOM 体积）。 */
const HISTORY_PAGE_SIZE = 50;

// Stable empty array so `messages` doesn't change identity on every render
// (which would re-trigger the auto-scroll effect needlessly).
const EMPTY_MESSAGES: ChatMessageData[] = [];

// Local UI session shape - maps backend ChatSession + holds loaded messages.
interface UISession {
  id: string; // chat_session_id from backend
  title: string;
  lastMessageAt: string;
  /** 会话绑定的科研项目（新建会话时可选）；缺省 = 普通对话 */
  academicProjectId?: string;
  messages: ChatMessageData[];
  historyLoaded: boolean;
  /** 已加载的最早一页（1-based）；>1 时顶部可继续加载更早消息。 */
  historyPage?: number;
  /** 服务端会话总消息数（仅用于「加载更早」状态）。 */
  historyTotal?: number;
}

function toUIMessage(m: ApiChatMessage): ChatMessageData {
  return {
    id: m.msg_id,
    role: m.role === "system" ? "assistant" : m.role,
    content: m.content,
    // Backend may return null; normalize to array.
    // sources 里的云盘引用（upload_uuid / uploadUuid）统一成 ChatSource.uploadUuid，
    // 保证历史消息里的文件引用也能渲染站内深链。
    sources: Array.isArray(m.sources)
      ? m.sources.map((s) => ({
          title: s.title,
          url: s.url,
          bvid: s.bvid,
          uploadUuid: s.uploadUuid ?? s.upload_uuid,
        }))
      : undefined,
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

/**
 * Load the latest slice of a session. The history API is offset-paged from the
 * oldest message, so a long session must first discover total, then fetch the
 * last page (plus the previous page so the first screen has ~50-100 messages,
 * not a 1-message tail). Prepending earlier pages happens in loadEarlier().
 */
async function fetchLatestMessages(
  sessionId: string,
  pageSize: number
): Promise<{ messages: ApiChatMessage[]; page: number; total: number }> {
  const first = await chatApi.getHistory(sessionId, 1, pageSize);
  if (first.total <= pageSize) {
    return { messages: first.messages, page: 1, total: first.total };
  }

  const lastPage = Math.ceil(first.total / pageSize);
  const latest = await chatApi.getHistory(sessionId, lastPage, pageSize);
  const previous =
    lastPage > 1
      ? await chatApi.getHistory(sessionId, lastPage - 1, pageSize)
      : null;

  const seen = new Set<string>();
  const merged: ApiChatMessage[] = [];
  for (const m of [...(previous?.messages ?? []), ...latest.messages]) {
    if (!seen.has(m.msg_id)) {
      seen.add(m.msg_id);
      merged.push(m);
    }
  }
  return {
    messages: merged,
    page: lastPage > 1 ? lastPage - 1 : 1,
    total: latest.total,
  };
}

async function fetchLatestHistory(sessionId: string): Promise<{
  messages: ChatMessageData[];
  page: number;
  total: number;
}> {
  const res = await fetchLatestMessages(sessionId, HISTORY_PAGE_SIZE);
  return { ...res, messages: res.messages.map(toUIMessage) };
}

function toUISession(s: ChatSession): UISession {
  return {
    id: s.chat_session_id,
    title: s.title || "新对话",
    lastMessageAt: s.last_message_at || s.updated_at || s.created_at,
    ...(s.academic_project_id ? { academicProjectId: s.academic_project_id } : {}),
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
  window?: "five_hour" | "day" | "month";
  resetAt?: number;
  upgradeSku?: string;
}

interface MessageRowProps {
  message: ChatMessageData;
  prev?: ChatMessageData;
  isStreaming: boolean;
  streamStartedAt?: number;
  editingMessageId: string | null;
  onRegenerate: (messageId: string) => void;
  onEdit: (messageId: string) => void;
  onEditSubmit: (messageId: string, content: string) => void;
  onEditCancel: () => void;
  onInteractionAnswer: (messageId: string, answer: string) => void;
  onImageOpen: (src: string) => void;
}

/**
 * One message row. Extracted + memoized so a streaming token only re-renders
 * the live assistant row: all callbacks below are stable wrappers owned by
 * ChatView, and historical message objects keep their identity.
 */
const MessageRow = memo(function MessageRow({
  message,
  prev,
  isStreaming,
  streamStartedAt,
  editingMessageId,
  onRegenerate,
  onEdit,
  onEditSubmit,
  onEditCancel,
  onInteractionAnswer,
  onImageOpen,
}: MessageRowProps) {
  const regenAnchor = prev && prev.role === "user" ? anchorIdOf(prev) : undefined;
  const canRegenerate =
    message.role === "assistant" &&
    (message.status === "completed" || message.status === "failed") &&
    !!regenAnchor;
  const editAnchor = message.role === "user" ? anchorIdOf(message) : undefined;
  const canEdit = !isStreaming && !!editAnchor;
  const showInteractionAnswer =
    message.interaction && !message.interactionAnswered && !isStreaming;

  return (
    <div
      className="mx-auto w-full max-w-[768px] px-3 pb-4 sm:px-5 sm:pb-5"
      data-message-id={message.id}
    >
      <ChatMessage
        role={message.role}
        content={message.content}
        images={message.images}
        onImageOpen={onImageOpen}
        sources={message.sources}
        artifacts={message.artifacts}
        reasoningSteps={message.reasoningSteps}
        reasoning={message.reasoning}
        queuePosition={message.queuePosition}
        subAgent={message.subAgent}
        interaction={message.interaction}
        interactionAnswered={message.interactionAnswered}
        plan={message.plan}
        onInteractionAnswer={
          showInteractionAnswer
            ? (answer: string) => onInteractionAnswer(message.id, answer)
            : undefined
        }
        status={message.status}
        error={message.error}
        timestamp={message.timestamp}
        streamStartedAt={streamStartedAt}
        onRegenerate={
          canRegenerate ? () => onRegenerate(message.id) : undefined
        }
        onEdit={canEdit ? () => onEdit(message.id) : undefined}
        isEditing={editingMessageId === message.id}
        onEditSubmit={(content) => onEditSubmit(message.id, content)}
        onEditCancel={onEditCancel}
      />
    </div>
  );
});

interface ChatViewProps {
  /**
   * 科研项目上下文（来自 /chat?academic_project=<id>，由 /research 详情页跳转带入）。
   * 新建会话时会把该项目绑定到会话上（会话级持久化）；已绑定会话优先使用自身绑定，
   * 本参数只作为没有绑定时的入口兜底。缺省 = 普通聊天。
   */
  academicProjectId?: string;
  /**
   * 云盘文件级问答（来自 /chat?upload_uuid=<uuid>，由云盘详情「问这份文件」跳入）。
   * 传入后请求体带 scope.uploadUuids=[uuid]，回答只基于该文件；缺省为普通聊天。
   */
  uploadUuid?: string;
  /**
   * 来自科研工作台「在对话中继续」（/chat?academic_project=<id>&new=1）：
   * 进入即进入草稿态（不落到最近历史会话，也不立即落库）；new=1 随后从 URL 移除。
   */
  startNew?: boolean;
}

export function ChatView({ academicProjectId, uploadUuid, startNew }: ChatViewProps = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlSessionId = searchParams.get("session");
  // Snapshot the first URL value so the one-time session loader doesn't re-run
  // when we replace the URL after selecting a session.
  const initialUrlSessionRef = useRef(urlSessionId);
  const seenSessionUrlRef = useRef(!!urlSessionId);
  const initialUrlAppliedRef = useRef(false);
  // 手机默认收起（侧栏是覆盖式抽屉）；桌面由下面的 media query 打开。
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sessions, setSessions] = useState<UISession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  // Wall-clock start of the live turn (Date.now() at send). Drives the elapsed
  // time in the pending running row and the "生成中 · Ns" hint by the stop
  // button. Cleared as soon as the turn completes / fails / is stopped.
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const [quotaBlock, setQuotaBlock] = useState<QuotaBlockInfo | null>(null);
  // 今日用量角标（/quota/summary）：挂载时与每轮结束后刷新
  const [quotaSummary, setQuotaSummary] = useState<QuotaSummary | null>(null);

  // 移动端适配：md+ 默认展开常驻侧栏，<768px 默认收起，避免首屏被 288px 抽屉盖住。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 768px)");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial layout comes from the browser viewport; no external system
    setSidebarOpen(mq.matches);
    const onChange = (event: MediaQueryListEvent) => {
      // 只在切到手机宽度时强制收起；桌面端保留用户手动折叠的选择。
      if (!event.matches) setSidebarOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const refreshQuota = useCallback(async () => {
    try {
      setQuotaSummary(await quotaApi.getSummary());
    } catch {
      // 用量展示是尽力而为，失败静默
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- best-effort usage badge fetch; setState happens after the awaited request
    void refreshQuota();
  }, [refreshQuota]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [quizDialogOpen, setQuizDialogOpen] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<SelectedSkill[]>([]);
  // Chat-dialog selection from the user's Coding Plan model catalog (code agent).
  const [codingPlanModel, setCodingPlanModel] = useState<string | undefined>();
  // 聊天模型目录与用户选择（GET /chat/models）；空目录 = 不传 model，后端用默认模型。
  const [chatModels, setChatModels] = useState<ChatModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  // Which user message is currently being edited inline (at most one).
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  // Stable wrappers for MessageRow: the underlying handlers change whenever
  // sessions/quota state changes, but memoized historical rows must not.
  const actionsRef = useRef<{
    regenerate: (messageId: string) => void;
    editSubmit: (messageId: string, content: string) => void;
    interactionAnswer: (messageId: string, answer: string) => void;
  } | null>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const messages = activeSession?.messages ?? EMPTY_MESSAGES;
  // Previous-message map for MessageRow (Virtuoso's item index includes
  // firstItemIndex, so index-1 is not a reliable data index after prepends).
  const prevMessageById = useMemo(() => {
    const map = new Map<string, ChatMessageData>();
    for (let i = 1; i < messages.length; i++) {
      map.set(messages[i].id, messages[i - 1]);
    }
    return map;
  }, [messages]);
  // 草稿态（还没创建会话）选中的科研项目：第一条消息创建会话时写入绑定。
  const [draftAcademicProjectId, setDraftAcademicProjectId] = useState<string | undefined>(academicProjectId);
  // 已选会话以自身绑定为准；草稿态用选择器/入口参数。
  const effectiveAcademicProjectId = activeSession
    ? activeSession.academicProjectId
    : (draftAcademicProjectId ?? academicProjectId);

  // 新建会话时可绑定科研项目：这里只取「用户自己的项目」用于侧栏选择器；
  // 失败静默（学术功能未启用时选择器隐藏，聊天不受影响）。
  const [researchProjects, setResearchProjects] = useState<Array<{ id: string; title: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await academicApi.listProjects();
        if (!cancelled) setResearchProjects(res.projects.map((p) => ({ id: p.id, title: p.title })));
      } catch {
        if (!cancelled) setResearchProjects([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- 聊天模型目录（GET /chat/models）----
  // 挂载时拉一次；失败静默（不阻塞聊天：请求不带 model，后端用默认模型）。
  // 本地记住的选择若不在目录里则回退 default（default 不在目录时按「默认模型」处理）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let stored: string | null = null;
      try {
        stored = window.localStorage.getItem(CHAT_MODEL_STORAGE_KEY);
      } catch {
        // 存储不可用：仅本次会话按默认模型
      }
      try {
        const catalog = await chatApi.listModels();
        if (cancelled) return;
        const models = catalog.models ?? [];
        setChatModels(models);
        const hasModel = (id: string) => models.some((m) => m.id === id);
        // 默认「默认模型」：不传 model，由后端 config.llm.model 决定；
        // 只有用户上次显式选过的系统模型才恢复。
        setSelectedModel(stored && hasModel(stored) ? stored : "");
      } catch {
        // 目录不可用：选择器隐藏，发送不带 model（后端默认）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 统一模型选择：默认 / 系统目录模型 / Coding Plan 模型三选一，互斥。
  const handleModelChange = useCallback((selection: ChatModelSelection) => {
    if (selection.kind === "coding-plan") {
      // Coding Plan 模型由 coding_plan_model 携带，系统模型清空。
      setCodingPlanModel(selection.model);
      setSelectedModel("");
      try {
        window.localStorage.removeItem(CHAT_MODEL_STORAGE_KEY);
      } catch {
        // 存储不可用：仅本次会话生效
      }
      return;
    }
    setCodingPlanModel(undefined);
    const modelId = selection.kind === "system" ? selection.id : "";
    setSelectedModel(modelId);
    try {
      if (modelId) window.localStorage.setItem(CHAT_MODEL_STORAGE_KEY, modelId);
      else window.localStorage.removeItem(CHAT_MODEL_STORAGE_KEY);
    } catch {
      // 存储不可用：仅本次会话生效
    }
  }, []);

  // Track which sessions have had their history fetched, so the load effect can
  // depend only on activeSessionId (not the whole sessions array, which changes
  // on every streamed token and would re-trigger the effect).
  const loadedRef = useRef<Set<string>>(new Set());
  const loadingHistoryRef = useRef<Set<string>>(new Set());
  // A session click updates state before router.push lands. Remember the target
  // so the URL-sync effect cannot briefly snap back to the previous ?session=.
  const pendingSessionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ---- 科研项目上下文（/chat?academic_project=<id>）----
  // 只用于顶部横幅展示；请求体字段直接取 props。拉取失败静默降级为普通聊天，
  // 绝不阻塞会话加载或发送。
  // 缓存带 id：URL 参数变化时旧数据自动失效，无需在 effect 内同步清空 state。
  const [loadedAcademicProject, setLoadedAcademicProject] = useState<{
    id: string;
    project: AcademicProjectSummary;
  } | null>(null);
  useEffect(() => {
    if (!effectiveAcademicProjectId) return;
    let cancelled = false;
    (async () => {
      try {
        const detail = await academicApi.getProject(effectiveAcademicProjectId);
        if (!cancelled) setLoadedAcademicProject({ id: effectiveAcademicProjectId, project: detail.project });
      } catch {
        // 项目不存在/无权访问/网络失败：横幅不显示，聊天照常（后端同样会忽略无效 id）
        if (!cancelled) setLoadedAcademicProject(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveAcademicProjectId]);
  const academicProject =
    loadedAcademicProject && loadedAcademicProject.id === effectiveAcademicProjectId
      ? loadedAcademicProject.project
      : null;

  /** Patch one session by id (流式更新必须按 id 定向：草稿态第一条消息会先惰性建会话). */
  const updateSession = useCallback((sessionId: string, updater: (s: UISession) => UISession) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? updater(s) : s)));
  }, []);

  const updateActiveSession = useCallback(
    (updater: (s: UISession) => UISession) => {
      if (!activeSessionId) return;
      updateSession(activeSessionId, updater);
    },
    [activeSessionId, updateSession]
  );

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
        if (startNew) {
          // 科研工作台「在对话中继续」：进入**草稿态**（还没发消息 = 还没创建），
          // 项目 id 由入口参数带入草稿，第一条消息创建会话时才写入绑定。
          setActiveSessionId(null);
          router.replace(
            academicProjectId ? `/chat?academic_project=${encodeURIComponent(academicProjectId)}` : "/chat",
          );
        } else if (mapped.length > 0) {
          const requested = initialUrlSessionRef.current;
          const selected = requested && mapped.some((s) => s.id === requested)
            ? requested
            : mapped[0].id;
          setActiveSessionId(selected);
          // Make the visible conversation addressable and refresh-safe. Invalid
          // ?session= ids fall back to the newest conversation.
          if (selected !== requested) {
            router.replace(`/chat?session=${encodeURIComponent(selected)}`, { scroll: false });
          }
        } else {
          // 没有任何会话：保持草稿态，不在服务端落空会话（第一条消息才创建）。
          setActiveSessionId(null);
          if (initialUrlSessionRef.current) {
            router.replace("/chat", { scroll: false });
          }
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "加载会话列表失败");
      } finally {
        if (!cancelled) {
          setIsLoadingSessions(false);
          initialUrlAppliedRef.current = true;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Back/forward (and manual ?session= edits) select the matching conversation.
  // This runs after the one-time loader so the first /chat render is not
  // overwritten by the no-session branch.
  useEffect(() => {
    if (!initialUrlAppliedRef.current || isLoadingSessions) return;
    if (!urlSessionId) {
      // Back to /chat after visiting a conversation = new draft. Do not clear
      // during the first /chat render before its auto-selected session URL lands.
      if (seenSessionUrlRef.current && activeSessionId) setActiveSessionId(null);
      return;
    }
    seenSessionUrlRef.current = true;
    // Wait for a session click's router.push to land before applying the stale
    // URL. Without this, clicking B while the URL still says A briefly selects
    // A again, cancels B's history fetch, and leaves the panel empty.
    if (pendingSessionRef.current && pendingSessionRef.current === activeSessionId) {
      if (urlSessionId === activeSessionId) pendingSessionRef.current = null;
      else return;
    }
    if (urlSessionId === activeSessionId) return;
    if (sessions.some((s) => s.id === urlSessionId)) {
      pendingSessionRef.current = null;
      setActiveSessionId(urlSessionId);
      stickToBottomRef.current = true;
      setEditingMessageId(null);
    }
  }, [urlSessionId, isLoadingSessions, startNew, sessions, activeSessionId]);

  // ---- Load message history when active session changes (once per session) ----
  useEffect(() => {
    if (!activeSessionId) return;
    if (loadedRef.current.has(activeSessionId)) return;
    if (loadingHistoryRef.current.has(activeSessionId)) return;
    loadingHistoryRef.current.add(activeSessionId);
    let completed = false;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetchLatestHistory(activeSessionId);
        if (cancelled) return;
        loadedRef.current.add(activeSessionId);
        completed = true;
        setSessions((prev) =>
          prev.map((s) =>
            s.id === activeSessionId
              ? {
                  ...s,
                  messages: res.messages,
                  historyLoaded: true,
                  historyPage: res.page,
                  historyTotal: res.total,
                }
              : s
          )
        );
      } catch (e) {
        if (cancelled) return;
        loadedRef.current.delete(activeSessionId);
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
      } finally {
        loadingHistoryRef.current.delete(activeSessionId);
        if (!completed) loadedRef.current.delete(activeSessionId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  // The chat route is a full-viewport app shell: lock the document scroll so
  // a long conversation can never turn the page (and the composer) into the
  // scroll container. The message viewport below owns all scrolling.
  useEffect(() => {
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevOverscroll = body.style.overscrollBehavior;
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    return () => {
      body.style.overflow = prevOverflow;
      body.style.overscrollBehavior = prevOverscroll;
    };
  }, []);

  // ---- Virtualized chat list / stick-to-bottom ----
  // Virtuoso owns the scroll container; followOutput keeps the live turn
  // pinned only while the user is already at the bottom.
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const listWrapRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  // Prepending a page must move the virtual index down so Virtuoso keeps the
  // current reading position instead of jumping to the new top.
  const [firstItemIndex, setFirstItemIndex] = useState(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const scrollToBottom = useCallback((smooth = true) => {
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    const el = scrollerRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
      return;
    }
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      align: "end",
      behavior: smooth ? "smooth" : "auto",
    });
  }, []);

  // FIRST render of a session: initialTopMostItemIndex is not enough when the
  // last message is taller than the viewport (it can land at the item's top and
  // leave the tail clipped). Force one bottom alignment after data arrives.
  const initialBottomSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeSessionId || messages.length === 0) return;
    if (initialBottomSessionRef.current === activeSessionId) return;
    initialBottomSessionRef.current = activeSessionId;
    stickToBottomRef.current = true;
    // The first measurement pass can land at the top of a tall last message;
    // keep pinning for a few frames until Virtuoso has measured the real height.
    let cancelled = false;
    let frames = 0;
    const pin = () => {
      if (cancelled) return;
      const el = scrollerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      } else {
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
      }
      frames += 1;
      if (frames < 20) requestAnimationFrame(pin);
    };
    const raf = requestAnimationFrame(pin);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [activeSessionId, messages.length]);

  const handleAtBottom = useCallback((atBottom: boolean) => {
    stickToBottomRef.current = atBottom;
    setShowJumpToBottom(!atBottom && messages.length > 0);
  }, [messages.length]);

  // Composer growth / mobile keyboard changes the viewport height; keep the
  // last message pinned when the user was at the bottom.
  useEffect(() => {
    const el = listWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) {
        const scroller = scrollerRef.current;
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Load the previous server page and prepend it. firstItemIndex+scroll
  // preservation are Virtuoso's documented "prepend" recipe.
  const loadEarlier = useCallback(async () => {
    const sessionId = activeSessionId;
    const sess = sessions.find((s) => s.id === sessionId);
    const page = sess?.historyPage;
    if (!sessionId || !sess || !page || page <= 1 || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const res = await chatApi.getHistory(sessionId, page - 1, HISTORY_PAGE_SIZE);
      const incoming = res.messages.map(toUIMessage);
      const existing = new Set(sess.messages.map((m) => m.id));
      const older = incoming.filter((m) => !existing.has(m.id));
      if (older.length > 0) {
        setFirstItemIndex((idx) => idx - older.length);
      }
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                messages: older.length > 0 ? [...older, ...s.messages] : s.messages,
                historyPage: page - 1,
                historyTotal: res.total,
              }
            : s
        )
      );
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "加载更早消息失败");
    } finally {
      setLoadingEarlier(false);
    }
  }, [activeSessionId, sessions, loadingEarlier]);

  // ---- Backfill real backend msg_ids after a streamed turn ----
  // The SSE protocol carries no msg_ids, so freshly-streamed messages only
  // have local placeholder ids. Once the turn settles, pair the local list
  // with server history (same order) and record each message's real id as
  // `serverId`, which per-turn regenerate needs to truncate server history.
  // Best-effort: on any mismatch (desync) or fetch error, keep local state.
  const backfillMessageIds = useCallback(async (targetSessionId?: string) => {
    const sessionId = targetSessionId ?? activeSessionId;
    if (!sessionId) return;
    try {
      // Same window as the initial load: latest ~50 messages. Compare only when
      // the UI still holds exactly that window (otherwise leave ids as-is).
      const latest = await fetchLatestMessages(sessionId, HISTORY_PAGE_SIZE);
      const server = latest.messages;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId || server.length !== s.messages.length) return s;
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

  // ---- Core: stream a question into one session ----
  // sessionId is explicit: the first message of a draft creates the session lazily,
  // so the state-backed activeSessionId is stale during that turn.
  const streamQuestion = useCallback(
    async (
      sessionId: string,
      question: string,
      assistantMsgId: string,
      skillIds?: string[],
      images?: string[],
    ) => {
      // All optimistic/stream updates below target this turn's session by id.
      const updateActiveSession = (updater: (s: UISession) => UISession) =>
        updateSession(sessionId, updater);
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
            chat_session_id: sessionId,
            ...(skillIds && skillIds.length > 0 ? { skill_ids: skillIds } : {}),
            // 模型三选一：Coding Plan 模型优先走用户套餐；否则系统模型；
            // 都不选则两个字段都不传，由后端 config.llm.model 决定。
            ...(codingPlanModel
              ? { coding_plan_model: codingPlanModel }
              : selectedModel
                ? { model: selectedModel }
                : {}),
            ...(images && images.length > 0 ? { images } : {}),
            // 科研项目上下文：会话绑定优先（新建会话时选定），URL 入口参数兜底。
            ...(effectiveAcademicProjectId
              ? { academic_project_id: effectiveAcademicProjectId }
              : {}),
            // 文件级问答：限定只基于该云盘文件检索/回答；普通聊天不带 scope。
            ...(uploadUuid ? { scope: { uploadUuids: [uploadUuid] } } : {}),
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
            // route frame = admission slot granted; the routed agent name is
            // intentionally NOT rendered in the UI (all turns go to main).
            onRoute: () => {
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantMsgId ? { ...m, queuePosition: undefined } : m
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
                    // Same step number: merge the start frame with its done frame.
                    // `done` always wins for status; the result preview and the
                    // duration only arrive on the done frame.
                    const next = [...existing];
                    next[idx] = {
                      ...next[idx],
                      action: step.action || next[idx].action,
                      status: step.status ?? next[idx].status,
                      query: step.query || next[idx].query,
                      reasoning: step.reasoning || next[idx].reasoning,
                      sources: step.sources?.length ? step.sources : next[idx].sources,
                      args: step.args || next[idx].args,
                      resultPreview: step.resultPreview ?? next[idx].resultPreview,
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
                        status: step.status,
                        query: step.query,
                        reasoning: step.reasoning,
                        sources: step.sources ?? [],
                        args: step.args,
                        resultPreview: step.resultPreview,
                        durationMs: step.durationMs,
                      },
                    ],
                  };
                }),
              }));
            },
            onError: (message: string, meta?: { code?: string; detail?: Record<string, unknown> }) => {
              flushStream();
              if (meta?.code === "QUOTA_EXCEEDED" || meta?.code === "COST_GUARD") {
                const detail = (meta.detail ?? {}) as {
                  kind?: string;
                  window?: "five_hour" | "day" | "month";
                  resetAt?: number;
                  upgradeSku?: string;
                };
                setQuotaBlock({
                  code: meta.code,
                  message,
                  kind: detail.kind,
                  window: detail.window,
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
        setStreamStartedAt(null);
        abortRef.current = null;
        void backfillMessageIds(sessionId);
        void refreshQuota();
      }
    },
    [updateSession, refreshSessions, backfillMessageIds, effectiveAcademicProjectId, uploadUuid, codingPlanModel, selectedModel]
  );

  // ---- Send a message (skillIds: forced-inject skills for this turn only) ----
  // “没发消息就不算创建”：草稿态的第一条消息才在服务端创建会话（并写入草稿选中的
  // 科研项目绑定），之后所有更新都按 sessionId 定向。
  const creatingSessionRef = useRef(false);
  const handleSend = useCallback(
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- pre-existing async send callback; React Compiler cannot preserve this manual memoization (behavior unchanged)
    async (userMessage: string, skillIds?: string[], images?: string[]) => {
      let sessionId = activeSessionId;
      if (!sessionId) {
        if (creatingSessionRef.current) return;
        creatingSessionRef.current = true;
        try {
          const created = await chatApi.createSession(undefined, effectiveAcademicProjectId);
          const ui = toUISession(created);
          ui.historyLoaded = true; // empty, no need to fetch history
          loadedRef.current.add(ui.id);
          setSessions((prev) => [ui, ...prev]);
          setActiveSessionId(ui.id);
          router.replace(`/chat?session=${encodeURIComponent(ui.id)}`, { scroll: false });
          sessionId = ui.id;
        } catch (e) {
          setLoadError(e instanceof Error ? e.message : "创建会话失败");
          return;
        } finally {
          creatingSessionRef.current = false;
        }
      }

      const userMsgId = `user-${Date.now()}`;
      const assistantMsgId = `assistant-${Date.now() + 1}`;
      const timestamp = new Date().toISOString();

      updateSession(sessionId, (s) => ({
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

      setStreamStartedAt(Date.now());
      void streamQuestion(sessionId, userMessage, assistantMsgId, skillIds, images);
      // Skills are per-turn (Claude-Code-style): consumed by this message.
      if (skillIds && skillIds.length > 0) setSelectedSkills([]);
    },
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- see handleSend comment above
    [activeSessionId, updateSession, streamQuestion, effectiveAcademicProjectId, router]
  );

  // ---- 生成中排队发送：Enter 不打断当前轮，加入 FIFO 队列，轮次结束后自动发送 ----
  const queuedRef = useRef<QueuedMessage[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const flushingRef = useRef(false);
  const updateQueue = useCallback((next: QueuedMessage[]) => {
    queuedRef.current = next;
    setQueuedMessages(next);
  }, []);
  const clearQueue = useCallback(() => updateQueue([]), [updateQueue]);
  const enqueueMessage = useCallback(
    (text: string, skillIds?: string[], images?: string[]) => {
      const entry: QueuedMessage = {
        id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        text,
        ...(skillIds && skillIds.length > 0 ? { skillIds } : {}),
        ...(images && images.length > 0 ? { images } : {}),
      };
      // FIFO, bounded: at most 5 pending turns.
      updateQueue([...queuedRef.current, entry].slice(-5));
    },
    [updateQueue]
  );
  const cancelQueued = useCallback(
    (id: string) => updateQueue(queuedRef.current.filter((item) => item.id !== id)),
    [updateQueue]
  );
  const handleSubmit = useCallback(
    (text: string, skillIds?: string[], images?: string[]) => {
      if (isStreaming) {
        enqueueMessage(text, skillIds, images);
        // Skills belong to the queued turn; consume them from the composer.
        if (skillIds && skillIds.length > 0) setSelectedSkills([]);
        return;
      }
      void handleSend(text, skillIds, images);
    },
    [isStreaming, enqueueMessage, handleSend]
  );
  // Send exactly one queued turn each time the active turn settles (done /
  // error / stop all flip isStreaming to false). The ref guard covers the
  // async session-creation window before isStreaming becomes true again.
  useEffect(() => {
    if (isStreaming || flushingRef.current || queuedRef.current.length === 0) return;
    const timer = setTimeout(() => {
      const [next, ...rest] = queuedRef.current;
      if (!next) return;
      flushingRef.current = true;
      updateQueue(rest);
      void handleSend(next.text, next.skillIds, next.images).finally(() => {
        flushingRef.current = false;
      });
    }, 30);
    return () => clearTimeout(timer);
  }, [isStreaming, queuedMessages.length, handleSend, updateQueue]);

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
      setStreamStartedAt(Date.now());
      void streamQuestion(activeSessionId, prevUser.content, newAssistantId);
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
      setStreamStartedAt(Date.now());
      void streamQuestion(activeSessionId, content, assistantMsgId);
    },
    [activeSessionId, isStreaming, sessions, updateActiveSession, streamQuestion]
  );

  // Latest implementation ref: MessageRow gets these stable callbacks forever,
  // so memo can skip every historical row while a live row streams. Updating
  // the ref in an effect (not during render) keeps React's refs rule.
  useEffect(() => {
    actionsRef.current = {
      regenerate: (messageId) => void handleRegenerate(messageId),
      editSubmit: (messageId, content) => void handleEditUserMessage(messageId, content),
      interactionAnswer: (messageId, answer) => handleInteractionAnswer(messageId, answer),
    };
  }, [handleRegenerate, handleEditUserMessage, handleInteractionAnswer]);
  const onRegenerateMessage = useCallback((messageId: string) => {
    actionsRef.current?.regenerate(messageId);
  }, []);
  const onEditSubmitMessage = useCallback((messageId: string, content: string) => {
    actionsRef.current?.editSubmit(messageId, content);
  }, []);
  const onInteractionAnswerMessage = useCallback((messageId: string, answer: string) => {
    actionsRef.current?.interactionAnswer(messageId, answer);
  }, []);
  const onEditMessage = useCallback((messageId: string) => {
    setEditingMessageId(messageId);
  }, []);
  const onEditCancel = useCallback(() => setEditingMessageId(null), []);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
    setStreamStartedAt(null);
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
    /* eslint-disable react-hooks/set-state-in-effect -- refresh the session-file list when the active session changes; request-driven async loader */
    if (activeSessionId) void refreshSessionFiles(activeSessionId);
    else setSessionFiles([]);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [activeSessionId, refreshSessionFiles]);

  const handleAttachDocuments = useCallback(
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- pre-existing async upload callback; React Compiler cannot preserve this manual memoization (behavior unchanged)
    async (files: File[]) => {
      // 无会话时先建一个（对齐 handleNewChat），否则上传没有归属
      let sessionId = activeSessionId;
      if (!sessionId) {
        try {
          const res = await chatApi.createSession(undefined, effectiveAcademicProjectId);
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
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- see handleAttachDocuments comment above
    [activeSessionId, refreshSessionFiles, effectiveAcademicProjectId]
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

  // ---- New chat: 草稿态（没发消息就不算创建）+ 清掉当前空会话 ----
  const handleNewChat = useCallback(
    async (projectId?: string) => {
      // 第一条消息正在惰性建会话：此时切草稿会让刚建出的会话变成"空会话"竞态。
      if (creatingSessionRef.current) return;
      // 当前会话一条消息都没有 = 等同于还没创建：直接删除，避免侧栏堆空对话。
      // 有上传文件的空会话保留：文件是真实内容，删会话会连带删文件和附件对象。
      if (activeSessionId) {
        const current = sessions.find((s) => s.id === activeSessionId);
        // historyLoaded 是必要条件：历史还没拉回来时 messages=[] 不代表真的空会话。
        if (current && current.historyLoaded && current.messages.length === 0) {
          const fileCount = await chatApi
            .listDocuments(activeSessionId)
            .then((res) => res.documents?.length ?? 0)
            .catch(() => -1); // 查询失败 → 保守保留，不误删
          if (fileCount === 0) {
            await chatApi.deleteSession(activeSessionId).catch(() => undefined);
            loadedRef.current.delete(activeSessionId);
            setSessions((prev) => prev.filter((s) => s.id !== activeSessionId));
          }
        }
      }
      // 切到新对话时丢弃尚未发送的排队消息（避免发到另一个会话）。
      clearQueue();
      pendingSessionRef.current = null;
      // 进入草稿：不创建服务端会话；项目选择留到第一条消息创建时写入绑定。
      setDraftAcademicProjectId(projectId);
      setActiveSessionId(null);
      setEditingMessageId(null);
      if (
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 767px)").matches
      ) {
        setSidebarOpen(false);
      }
      // URL 上的 session/academic_project 只是入口提示；本次选择已记入草稿，
      // 回到无 session 的草稿 URL（上传文件上下文仍保留给云盘入口）。
      router.replace(
        uploadUuid ? `/chat?upload_uuid=${encodeURIComponent(uploadUuid)}` : "/chat",
        { scroll: false }
      );
    },
    [activeSessionId, sessions, academicProjectId, uploadUuid, router, clearQueue]
  );

  const handleSessionSelect = useCallback((sessionId: string) => {
    // 切换会话时丢弃队列，避免把排队消息发到另一个会话。
    clearQueue();
    pendingSessionRef.current = sessionId;
    setActiveSessionId(sessionId);
    router.push(`/chat?session=${encodeURIComponent(sessionId)}`, { scroll: false });
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
  }, [clearQueue, router]);

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await chatApi.deleteSession(sessionId);
        if (activeSessionId === sessionId) clearQueue();
        loadedRef.current.delete(sessionId);
        const remaining = sessions.filter((s) => s.id !== sessionId);
        setSessions(remaining);
        if (activeSessionId === sessionId) {
          const nextActive = remaining[0]?.id ?? null;
          pendingSessionRef.current = nextActive;
          setActiveSessionId(nextActive);
          router.replace(
            nextActive
              ? `/chat?session=${encodeURIComponent(nextActive)}`
              : "/chat",
            { scroll: false }
          );
        }
        // Deleting the last session falls back to the draft state — a session
        // without messages does not need to exist on the server.
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "删除会话失败");
      }
    },
    [activeSessionId, sessions, clearQueue, router]
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
    : sessions.map((s) => ({
        id: s.id,
        title: s.title,
        lastMessageAt: s.lastMessageAt,
        ...(s.academicProjectId ? { academicProjectId: s.academicProjectId } : {}),
      }));

  return (
    <div className="relative flex h-[100dvh] max-h-[100dvh] w-full overflow-hidden overscroll-none pt-[env(safe-area-inset-top)]">
      <ChatSidebar
        sessions={sidebarSessions}
        activeSessionId={activeSessionId ?? undefined}
        onSessionSelect={handleSessionSelect}
        onNewChat={handleNewChat}
        researchProjects={researchProjects}
        onDeleteSession={handleDeleteSession}
        onRenameSession={handleRenameSession}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white">
        <ChatHeader
          title={activeSession?.title ?? "MindBase"}
          hasMessages={messages.length > 0}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onClearChat={handleClearChat}
          onSummarize={() => setSummaryOpen(true)}
          isStreaming={isStreaming}
        />

        {loadError && (
          <div className="border-b border-danger/10 bg-danger/5 px-4 py-2 text-[12px] text-danger">
            {loadError}
          </div>
        )}

        {/* 科研项目上下文横幅：URL 带入项目即显示（标题/阶段拉取失败时用占位文案，不静默消失） */}
        {effectiveAcademicProjectId && (
          <div className="flex items-center gap-2 border-b border-accent/10 bg-accent-soft px-4 py-2 text-[12px] text-foreground">
            <FlaskConical className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              正在科研项目：
              <span className="font-medium">{academicProject?.title ?? "已关联科研项目（信息加载中…）"}</span>
              {academicProject && (
                <span className="text-secondary">（阶段 {STAGE_LABELS[academicProject.stage]}）</span>
              )}
            </span>
            <Link
              href="/research"
              className="shrink-0 text-accent transition-opacity hover:opacity-80 hover:underline"
            >
              返回科研工作台
            </Link>
          </div>
        )}

        {/* Messages scroll area — virtualized; only the viewport (+overscan) is
            in the DOM. This replaces a content-visibility stopgap: layering
            content-visibility on top would fight Virtuoso's dynamic height
            measurement for no extra gain (offscreen rows are not mounted). */}
        <div ref={listWrapRef} className="relative min-h-0 flex-1 overflow-hidden">
          {messages.length === 0 ? (
            <ChatEmpty onSuggestionClick={handleSend} />
          ) : (
            <Virtuoso
              key={activeSessionId ?? "draft"}
              ref={virtuosoRef}
              scrollerRef={(ref) => {
                scrollerRef.current = ref instanceof HTMLElement ? ref : null;
              }}
              className="chat-scrollbar h-full"
              style={{ height: "100%" }}
              data={messages}
              firstItemIndex={firstItemIndex}
              initialTopMostItemIndex={messages.length - 1}
              computeItemKey={(_, message) => message.id}
              followOutput={(atBottom) =>
                atBottom ? (isStreaming ? "auto" : "smooth") : false
              }
              atBottomStateChange={handleAtBottom}
              atBottomThreshold={80}
              increaseViewportBy={{ top: 600, bottom: 600 }}
              alignToBottom
              components={{
                Header: () => (
                  <div className="mx-auto w-full max-w-[768px] px-3 pt-4 sm:px-5 sm:pt-6">
                    {(activeSession?.historyPage ?? 1) > 1 && (
                      <div className="mb-5 flex justify-center">
                        <button
                          type="button"
                          onClick={() => void loadEarlier()}
                          disabled={loadingEarlier}
                          className="btn-pill btn-ghost inline-flex h-8 items-center gap-1.5 px-3 text-[11px] disabled:opacity-60"
                        >
                          {loadingEarlier && (
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                          )}
                          {loadingEarlier ? "加载中…" : "加载更早消息"}
                        </button>
                      </div>
                    )}
                  </div>
                ),
              }}
              itemContent={(_, message) => (
                <MessageRow
                  message={message}
                  prev={prevMessageById.get(message.id)}
                  isStreaming={isStreaming}
                  streamStartedAt={
                    message.status === "pending" ? streamStartedAt ?? undefined : undefined
                  }
                  editingMessageId={editingMessageId}
                  onRegenerate={onRegenerateMessage}
                  onEdit={onEditMessage}
                  onEditSubmit={onEditSubmitMessage}
                  onEditCancel={onEditCancel}
                  onInteractionAnswer={onInteractionAnswerMessage}
                  onImageOpen={setLightboxSrc}
                />
              )}
            />
          )}

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
        <div className="relative z-10 shrink-0 bg-gradient-to-t from-white via-white to-white/90 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-5">
          <div className="mx-auto max-w-[768px]">
            {/* 文件级问答提示：/chat?upload_uuid= 进入时只基于该文件回答 */}
            {uploadUuid && (
              <div className="mb-2 flex items-center gap-2 rounded-xl border border-accent/20 bg-accent-soft px-3 py-2 text-[12px] text-foreground">
                <FileText className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">
                  仅基于该云盘文件回答
                  <span className="ml-1.5 font-mono text-[11px] text-secondary">
                    {uploadUuid.slice(0, 8)}…
                  </span>
                </span>
                <Link
                  href="/chat"
                  className="shrink-0 text-accent transition-opacity hover:opacity-80 hover:underline"
                >
                  普通聊天
                </Link>
              </div>
            )}
            {(() => {
              const day = quotaSummary?.enabled
                ? quotaSummary.windows?.find((w) => w.window === "day")
                : undefined;
              const fiveHour = quotaSummary?.enabled
                ? quotaSummary.windows?.find((w) => w.window === "five_hour")
                : undefined;
              if (!day || day.limit < 0) return null;
              const ratio = day.limit > 0 ? day.used / day.limit : 0;
              return (
                <div className="mb-1 flex justify-end gap-3 px-1 text-xs text-secondary">
                  <span>今日 token 用量 {day.usedPercent ?? 0}%</span>
                  {fiveHour && fiveHour.used > 0 && (
                    <span>5 小时窗口 {fiveHour.usedPercent ?? 0}%</span>
                  )}
                  {ratio >= 0.8 ? <span>· 额度即将用完</span> : null}
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
                      ? `${quotaBlock.window === "five_hour" ? "5 小时滚动窗口" : quotaBlock.window === "month" ? "本月" : "今日"}重置：${new Date(quotaBlock.resetAt).toLocaleString()} · `
                      : ""}
                    token 额度按模型折算；升级会员可获得更高额度与会员优先队列
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
            <QueuedMessages items={queuedMessages} onCancel={cancelQueued} />
            <ChatInput
              onSend={handleSubmit}
              disabled={false}
              queuedCount={queuedMessages.length}
              isStreaming={isStreaming}
              streamStartedAt={streamStartedAt ?? undefined}
              onStop={handleStop}
              selectedSkills={selectedSkills}
              onToggleSkill={handleToggleSkill}
              onOpenQuizWizard={() => setQuizDialogOpen(true)}
              onAttachDocuments={handleAttachDocuments}
              sessionFiles={sessionFiles}
              onDeleteSessionFile={handleDeleteSessionFile}
              onPreviewImage={setLightboxSrc}
              models={chatModels}
              selectedModel={selectedModel}
              codingPlanModel={codingPlanModel}
              onModelChange={handleModelChange}
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
