/**
 * 对话工作区（默认主页）：左侧会话历史 + 右侧流式聊天。
 *
 * 状态机：draft（activeId=null，首条消息时才真正建会话）→ 发送后乐观插入
 * user 气泡与 pending assistant 气泡，Channel 事件逐 delta 追加、更新来源，
 * done 固化 msgId / error 标失败。切换会话通过 runToken 丢弃在途事件——
 * 后端照常落库，切回时 history 即权威数据。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
} from "react";
import {
  chatAsk,
  chatTitlePrefix,
  createSession,
  CHAT_MODE_JUMP_KEY,
  CHAT_MODE_STORAGE_KEY,
  deleteSession,
  getHistory,
  listSessions,
  MODE_SUFFIX,
  normalizeChatMode,
  renameSession,
  stopChat,
} from "../../lib/chat";
import type { ChatEvent, ChatMode, ChatSessionRow } from "../../lib/chat";
import {
  CHAT_IMAGE_MAX_COUNT,
  CHAT_IMAGE_MAX_TOTAL_BYTES,
  createImageAttachment,
  formatImageSize,
  imageDisplayName,
  pickImageFiles,
  readImageAsDataUrl,
  totalImageBytes,
  validateImageFile,
  type ChatImageAttachment,
} from "../../lib/chat-images";
import type { PendingJump } from "../../lib/router";
import { listProviders, type ProviderStatus } from "../../lib/api-keys";
import { listSkills, type SkillMeta } from "../../lib/skills";
import { toErrorMessage } from "../../lib/updater";
import SessionSidebar from "./SessionSidebar";
import MessageList, { parseClarify } from "./MessageList";
import SummaryModal from "./SummaryModal";
import SkillMenu from "./SkillMenu";
import ImageAttachmentStrip from "./ImageAttachmentStrip";
import SpawnTaskModal from "./SpawnTaskModal";
import type { UiMessage } from "./MessageList";

/** localStorage key remembering the sidebar fold across restarts. */
const RAIL_COLLAPSED_KEY = "mb.chat.rail-collapsed";

/** 对话类提供方 → 显示名（与 API 设置一致）。 */
const CHAT_PROVIDER_LABELS: Record<string, string> = {
  dashscope: "DashScope",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
};

/** Harness tool names → 中文步骤标签. */
const STEP_LABELS: Record<string, string> = {
  vector_search: "检索",
  list_documents: "查阅知识库",
  search_chat_history: "搜索历史对话",
  get_recent_context: "读取最近对话",
  get_full_history: "读取完整历史",
  get_compressed_summary: "读取会话摘要",
  save_note: "保存笔记",
  list_notes: "查阅笔记列表",
  get_note: "读取笔记",
  update_note: "更新笔记",
  delegate_to_agent: "委托子代理",
};

/** One Step event → a human progress line (query omitted when empty). */
function describeStep(action: string, query: string): string {
  const label = STEP_LABELS[action] ?? action;
  return query === "" ? label : `${label}：${query}`;
}

interface ChatViewProps {
  /** 命令面板的跨视图跳转请求；本视图消费后经 onPendingConsumed 归零。 */
  pending: PendingJump | null;
  onPendingConsumed: () => void;
}

/** Paper-plane glyph for the round send button. */
function SendIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4.5 11.2 19.5 4.8c.5-.2 1 .3.8.8l-6.4 15c-.2.5-.9.5-1.1 0l-2.4-5.6-5.9-2.7c-.5-.2-.5-.9 0-1.1z" strokeLinejoin="round" />
      <path d="m10.4 15 9.9-9.9" strokeLinecap="round" />
    </svg>
  );
}

/** Queue glyph for the background-task entry (top bar). */
function TaskIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.6" />
      <rect x="13" y="4" width="7" height="7" rx="1.6" />
      <rect x="4" y="13" width="7" height="7" rx="1.6" />
      <path d="M13.6 16.5h6.4M16.8 13.3v6.4" strokeLinecap="round" />
    </svg>
  );
}

/** Stop-square glyph for the interrupt button (shown while generating). */
function StopIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </svg>
  );
}

/** 回形针 glyph：输入框左侧的「添加图片」入口。 */
function PaperclipIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path
        d="M20 11.4 12.3 19a4.6 4.6 0 0 1-6.5-6.5l8.3-8.2a3.1 3.1 0 0 1 4.4 4.4l-8.2 8.2a1.6 1.6 0 0 1-2.3-2.3l7.5-7.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChatView({ pending, onPendingConsumed }: ChatViewProps): React.JSX.Element {
  // 对话工作模式（右上角分段选择器切换）：chat=普通对话、resume=简历制作、
  // slides=PPT 制作。模式决定会话列表的过滤（按标题后缀）与新会话的命名；
  // 持久化在 localStorage，重启恢复。
  const [mode, setMode] = useState<ChatMode>(() =>
    normalizeChatMode(window.localStorage.getItem(CHAT_MODE_STORAGE_KEY)),
  );
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  // 对话进行中实时展示「现在是谁在干活」：step/subStep 事件驱动，收尾清空。
  const [liveAgent, setLiveAgent] = useState<{ name: string; action: string; step: number } | null>(
    null,
  );
  // 任务计划面板状态：plan 事件驱动（创建/更新/修订），收尾清空。
  const [planView, setPlanView] = useState<{
    version: number;
    steps: { desc: string; status: string; note: string }[];
  } | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // True between pressing 停止 and the turn actually finishing.
  const [stopping, setStopping] = useState(false);
  // Crosses into applyEvent so the done frame can mark the manual interrupt.
  const interruptRequestedRef = useRef(false);
  const [loadError, setLoadError] = useState("");
  const [collapsed, setCollapsed] = useState<boolean>(
    () => window.localStorage.getItem(RAIL_COLLAPSED_KEY) === "1",
  );
  // 打开中的会话总结弹窗（null = 关闭）。
  const [summaryTarget, setSummaryTarget] = useState<{ id: string; title: string } | null>(null);
  // 后台任务弹窗（agent + 任务描述 → agent_task_spawn）。
  const [spawnOpen, setSpawnOpen] = useState(false);
  // 对话提供方选择：null = 跟随 API 设置的默认；已配置密钥的对话类提供方才可选。
  const [chatProvider, setChatProvider] = useState<string | null>(null);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [providerOptions, setProviderOptions] = useState<ProviderStatus[]>([]);
  // 技能：全量清单（菜单数据源）、"/" 菜单状态（query=过滤词 + 高亮下标）、
  // 已附加技能（发送时强制注入本轮，发送后清空）。
  const [allSkills, setAllSkills] = useState<SkillMeta[]>([]);
  const [skillMenu, setSkillMenu] = useState<{ query: string; index: number } | null>(null);
  const [attachedSkill, setAttachedSkill] = useState<SkillMeta | null>(null);
  // 本轮待发送的图片附件（选择 / 粘贴 / 拖拽统一走 addImageFiles）：发送成功
  // 后清空、失败保留让用户可直接重发；生成中禁用增删（按钮 / 删除键置灰）。
  const [pendingImages, setPendingImages] = useState<ChatImageAttachment[]>([]);
  const [imageError, setImageError] = useState("");
  const [imageDragActive, setImageDragActive] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave 在嵌套子元素间会成对抖动，用计数抵消后再收高亮。
  const imageDragDepth = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void listProviders().then(
      (statuses) => {
        if (cancelled) return;
        setProviderOptions(statuses.filter((p) => p.hasKey));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);
  // 点击选择器外部时收起菜单。
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!providerMenuOpen) return;
    function onPointerDown(event: PointerEvent): void {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setProviderMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [providerMenuOpen]);

  // Bumped on session switch / new draft; in-flight events with a stale
  // token are dropped (the backend finishes persisting regardless).
  const runToken = useRef(0);
  const localCounter = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // MessageRow 是 memo 行，会缓存交互卡作答那次渲染的闭包：作答必须读最新
  // 的 send / busy，否则回合收尾的旧闭包（busy=true）会让点击静默失效。
  const sendRef = useRef<(text?: string) => Promise<void>>(async () => undefined);
  const busyRef = useRef(false);

  // Auto-grow the composer with its content, capped at ~8 lines.
  useEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // 薄入口页（简历/PPT）经 sessionStorage 带来的草稿：mount 时取走一次，
  // 预填进输入框（不自动发送——用户可能想先补充说明）。
  useEffect(() => {
    const draft = window.sessionStorage.getItem("mb-draft-input");
    if (draft === null || draft === "") return;
    window.sessionStorage.removeItem("mb-draft-input");
    setInput(draft);
    inputRef.current?.focus();
  }, []);

  // Persist the fold decision.
  useEffect(() => {
    window.localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  // Ctrl/Cmd+B folds and unfolds the history rail, editor-style.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setCollapsed((value) => !value);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // 薄入口页（简历/PPT）一次性跳转模式：取走即用。
    const jumpMode = window.sessionStorage.getItem(CHAT_MODE_JUMP_KEY);
    if (jumpMode !== null) {
      window.sessionStorage.removeItem(CHAT_MODE_JUMP_KEY);
      const normalized = normalizeChatMode(jumpMode);
      setMode(normalized);
      window.localStorage.setItem(CHAT_MODE_STORAGE_KEY, normalized);
    }
    void listSessions().then(
      (rows) => {
        if (cancelled) return;
        setSessions(rows);
        // 点「对话」进入时自动落到最近的会话（列表首位）；但命令面板已
        // 指定目标会话时让位——pending effect 负责选中，避免竞态覆盖。
        if (pending?.kind === "open-session") return;
        const expected = jumpMode !== null ? normalizeChatMode(jumpMode) : mode;
        const visible = visibleSessionRows(rows, expected);
        // 落到当前模式下最近的会话（草稿态留给各模式自己的空态引导）。
        if (expected === "chat" && rows.length > 0) selectSession(rows[0].chatSessionId);
        else if (expected !== "chat" && visible.length > 0) selectSession(visible[0].chatSessionId);
      },
      (err) => {
        if (!cancelled) setLoadError(toErrorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount 一次性引导，刻意只用初始闭包
  }, []);

  // 命令面板的跨视图跳转：打开指定会话 / 新建对话，消费后归零。
  // 注意：hashchange 异步于 setPending，本视图可能先收到发往其他视图的
  // pending——不属于本视图的 kind 必须原样放行，绝不能消费。
  useEffect(() => {
    if (pending === null) return;
    if (
      pending.kind !== "open-session" &&
      pending.kind !== "new-session" &&
      pending.kind !== "draft"
    ) {
      return;
    }
    if (pending.kind === "open-session" && pending.id !== "") {
      selectSession(pending.id);
    } else if (pending.kind === "new-session") {
      startDraft();
    } else if (pending.kind === "draft") {
      // 薄入口页（简历/PPT）把生成请求带进对话：切回草稿态并预填输入框。
      startDraft();
      setInput(pending.text);
      inputRef.current?.focus();
    }
    onPendingConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pending 变化即消费一次
  }, [pending]);

  // "/" 菜单的过滤结果：只列启用项，名称或描述包含过滤词。
  const filteredSkills =
    skillMenu === null
      ? []
      : allSkills.filter((skill) => {
          if (!skill.enabled) return false;
          const query = skillMenu.query.trim().toLowerCase();
          return (
            query === "" ||
            skill.name.toLowerCase().includes(query) ||
            skill.description.toLowerCase().includes(query)
          );
        });
  const menuIndex =
    skillMenu === null ? 0 : Math.min(skillMenu.index, Math.max(filteredSkills.length - 1, 0));

  /** 选中技能 → 附加到下一轮发送（chip 可移除），清空 "/" 草稿。 */
  function pickSkill(skill: SkillMeta): void {
    setAttachedSkill(skill);
    setInput("");
    setSkillMenu(null);
    inputRef.current?.focus();
  }

  /**
   * 统一的图片入口（选择 / 粘贴 / 拖拽）：先按与后端相同的规则做前端预校验
   * （数量 ≤4、类型、单张 ≤5MB、合计 ≤15MB），再逐个读成 data URL。不合规
   * 的文件不加入，并在输入框上方给出中文原因。
   */
  async function addImageFiles(files: File[]): Promise<void> {
    if (busy || files.length === 0) return;
    let next = pendingImages;
    let error = "";
    for (const file of files) {
      if (next.length >= CHAT_IMAGE_MAX_COUNT) {
        error = `最多只能附带 ${CHAT_IMAGE_MAX_COUNT} 张图片（已选 ${next.length} 张）`;
        break;
      }
      const invalid = validateImageFile(file);
      if (invalid !== null) {
        error = `「${imageDisplayName(file)}」${invalid}`;
        continue;
      }
      if (totalImageBytes(next) + file.size > CHAT_IMAGE_MAX_TOTAL_BYTES) {
        error = `图片总大小不能超过 15MB（已选 ${formatImageSize(totalImageBytes(next))}）`;
        continue;
      }
      try {
        const dataUrl = await readImageAsDataUrl(file);
        next = [...next, createImageAttachment(file, dataUrl)];
        setPendingImages(next);
      } catch {
        error = `「${imageDisplayName(file)}」读取失败，请重试`;
      }
    }
    setImageError(error);
  }

  function hasFileDrag(event: ReactDragEvent<HTMLDivElement>): boolean {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  /** 拖拽悬停在输入区：高亮 + 阻止 webview 打开文件。 */
  function handleImageDragEnter(event: ReactDragEvent<HTMLDivElement>): void {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    imageDragDepth.current += 1;
    setImageDragActive(true);
  }

  function handleImageDragOver(event: ReactDragEvent<HTMLDivElement>): void {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleImageDragLeave(event: ReactDragEvent<HTMLDivElement>): void {
    if (!hasFileDrag(event)) return;
    imageDragDepth.current = Math.max(0, imageDragDepth.current - 1);
    if (imageDragDepth.current === 0) setImageDragActive(false);
  }

  function handleImageDrop(event: ReactDragEvent<HTMLDivElement>): void {
    event.preventDefault();
    imageDragDepth.current = 0;
    setImageDragActive(false);
    if (busy) return;
    const dropped = Array.from(event.dataTransfer.files);
    const images = pickImageFiles(dropped);
    if (images.length === 0) {
      if (dropped.length > 0) setImageError("只能拖入图片文件（PNG / JPEG / WEBP / GIF）");
      return;
    }
    void addImageFiles(images);
  }

  /** 粘贴截图 / 从剪贴板复制的图片文件。 */
  function handleComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void {
    if (busy) return;
    const clipboard = event.clipboardData;
    if (clipboard === null) return;
    const fromFiles = Array.from(clipboard.files);
    const fromItems = Array.from(clipboard.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    const images = pickImageFiles(fromFiles.length > 0 ? fromFiles : fromItems);
    if (images.length === 0) return;
    // 截图粘贴时剪贴板常同时带文字和图片，图片优先。
    event.preventDefault();
    void addImageFiles(images);
  }

  const patchLastAssistant = useCallback(
    (patch: Partial<UiMessage>) => {
      setMessages((prev) => {
        if (prev.length === 0 || prev[prev.length - 1].role !== "assistant") return prev;
        const next = [...prev];
        next[next.length - 1] = { ...next[next.length - 1], ...patch };
        return next;
      });
    },
    [],
  );

  /**
   * 交互卡作答：先标记该消息的卡片为已作答（只读），再把作答内容作为下一条
   * 用户消息发出——与手输走同一条 send 路径（会话创建/技能注入一致）。
   */
  const answerInteraction = useCallback((messageId: string, text: string): void => {
    if (busyRef.current) return;
    setMessages((prev) =>
      prev.map((message) =>
        message.id === messageId && message.interaction !== undefined
          ? { ...message, interaction: { ...message.interaction, answered: true } }
          : message,
      ),
    );
    void sendRef.current(text);
  }, []);

  // Codex 式澄清候选：最后一条消息是「已完成」的助手回复且命中澄清协议
  // 时，在输入框上方展示可点选的方向，点选即作为新消息发送。生成中 /
  // 用户已追问（最后一条是 user）时自动消失；✕ 可手动收起（同一问题
  // 不再弹出，换新问题会重新出现）。
  const lastMessage = messages[messages.length - 1];
  const clarify =
    !busy &&
    lastMessage !== undefined &&
    lastMessage.role === "assistant" &&
    lastMessage.status === "completed"
      ? parseClarify(lastMessage.content)
      : null;
  const clarifyKey = clarify === null ? "" : `${clarify.question}|${clarify.options.join("|")}`;
  const [dismissedClarifyKey, setDismissedClarifyKey] = useState("");
  const clarifyVisible = clarify !== null && dismissedClarifyKey !== clarifyKey;
  // Codex 式两段交互：点候选 = 选中（行高亮 + 填入输入框），发送仍走输入框
  // 的回车/按钮——用户在选中后还能改写内容。换新问题时选中态作废。
  const [picked, setPicked] = useState<{ key: string; index: number } | null>(null);
  const pickedIndex = clarifyVisible && picked !== null && picked.key === clarifyKey ? picked.index : -1;
  function pickClarifyOption(index: number, option: string): void {
    setPicked({ key: clarifyKey, index });
    setInput(option);
    inputRef.current?.focus();
  }

  function selectSession(sessionId: string): void {
    if (sessionId === activeId) return;
    const token = ++runToken.current;
    setActiveId(sessionId);
    setMessages([]);
    void getHistory(sessionId).then(
      (rows) => {
        // 过期响应丢弃：快速连续切换会话时，慢的旧历史不得覆盖新会话。
        if (runToken.current !== token) return;
        setMessages(
          rows.map((row) => ({
            id: row.msgId,
            role: row.role,
            content: row.content,
            status: row.status === "failed" ? "failed" : "completed",
            sources: Array.isArray(row.sources) ? row.sources : [],
            error: row.error,
            steps: [],
            // 历史重载与实时表现一致：后端落库的 usage JSON 一并回溯。
            usage: row.usage ?? null,
          })),
        );
      },
      (err) => {
        if (runToken.current === token) setLoadError(toErrorMessage(err));
      },
    );
  }

  /** Draft state: an unnamed conversation created on the first message. */
  function startDraft(): void {
    runToken.current += 1;
    setActiveId(null);
    setMessages([]);
  }

  /** 按模式过滤会话：普通对话隐藏带类型后缀的会话，简历/PPT 只看自己的。 */
  function visibleSessionRows(
    rows: ChatSessionRow[],
    forMode: ChatMode,
  ): ChatSessionRow[] {
    if (forMode === "chat") {
      return rows.filter(
        (row) =>
          !row.title.endsWith(MODE_SUFFIX.resume) &&
          !row.title.endsWith(MODE_SUFFIX.slides),
      );
    }
    return rows.filter((row) => row.title.endsWith(MODE_SUFFIX[forMode]));
  }

  /** 切换模式：持久化；当前会话不属于新模式时回到草稿态（消息区随之换场）。 */
  function switchMode(next: ChatMode): void {
    if (next === mode) return;
    setMode(next);
    window.localStorage.setItem(CHAT_MODE_STORAGE_KEY, next);
    const active = sessions.find((row) => row.chatSessionId === activeId);
    const expected = next === "chat" ? "" : MODE_SUFFIX[next];
    if (activeId !== null && !(active?.title ?? "").endsWith(expected)) {
      startDraft();
    }
  }

  async function removeSession(sessionId: string): Promise<void> {
    try {
      await deleteSession(sessionId);
      setSessions((prev) => prev.filter((session) => session.chatSessionId !== sessionId));
      if (activeId === sessionId) startDraft();
    } catch (err) {
      setLoadError(toErrorMessage(err));
    }
  }

  async function doRename(sessionId: string, title: string): Promise<void> {
    try {
      await renameSession(sessionId, title);
      setSessions((prev) =>
        prev.map((session) =>
          session.chatSessionId === sessionId ? { ...session, title } : session,
        ),
      );
    } catch (err) {
      setLoadError(toErrorMessage(err));
    }
  }

  function applyEvent(event: ChatEvent): void {
    switch (event.type) {
      case "step":
        setLiveAgent({ name: "chat 主力", action: describeStep(event.action, event.query), step: event.step });
        setMessages((prev) => {
          if (prev.length === 0 || prev[prev.length - 1].role !== "assistant") return prev;
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = {
            ...last,
            steps: [...last.steps, describeStep(event.action, event.query)],
          };
          return next;
        });
        break;
      case "plan":
        setPlanView({ version: event.version, steps: event.steps });
        break;
      case "subStep":
        setLiveAgent({
          name: `${event.agent}（子代理）`,
          action: describeStep(event.action, event.query),
          step: event.step,
        });
        setMessages((prev) => {
          if (prev.length === 0 || prev[prev.length - 1].role !== "assistant") return prev;
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = {
            ...last,
            steps: [
              ...last.steps,
              `子agent步骤（${event.agent}）· ${describeStep(event.action, event.query)}`,
            ],
          };
          return next;
        });
        break;
      case "chunk":
        setMessages((prev) => {
          if (prev.length === 0 || prev[prev.length - 1].role !== "assistant") return prev;
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = { ...last, content: last.content + event.content };
          return next;
        });
        break;
      case "sources":
        patchLastAssistant({ sources: event.sources });
        break;
      case "usage":
        // token 用量帧：挂到本轮 pending 助手消息，done 时随消息保留。
        patchLastAssistant({ usage: event.usage });
        break;
      case "interact":
        // ask_user：本轮随即结束，交互卡挂到当前 pending 助手消息上，作答
        // 即作为下一条用户消息发送（applyEvent 不接管发送）。
        if (!event.interact) break;
        patchLastAssistant({
          interaction: { payload: event.interact, answered: false },
        });
        break;
      case "artifact": {
        // 本轮新生成的产物：按 path 去重后追加到当前助手消息。
        const incoming = Array.isArray(event.artifacts) ? event.artifacts : [];
        if (incoming.length === 0) break;
        setMessages((prev) => {
          if (prev.length === 0 || prev[prev.length - 1].role !== "assistant") return prev;
          const next = [...prev];
          const last = next[next.length - 1];
          const existing = last.artifacts ?? [];
          const seen = new Set(existing.map((item) => item.path));
          const merged = [...existing];
          for (const item of incoming) {
            if (seen.has(item.path)) continue;
            seen.add(item.path);
            merged.push(item);
          }
          next[next.length - 1] = { ...last, artifacts: merged };
          return next;
        });
        break;
      }
      case "title":
        setSessions((prev) =>
          prev.map((session) =>
            session.chatSessionId === activeId ? { ...session, title: event.title } : session,
          ),
        );
        break;
      case "done":
        // A manual interrupt with zero streamed text would otherwise leave an
        // empty bubble — fill in the same marker the backend persists.
        setMessages((prev) => {
          if (prev.length === 0 || prev[prev.length - 1].role !== "assistant") return prev;
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = {
            ...last,
            id: event.msgId,
            status: "completed",
            content:
              interruptRequestedRef.current && last.content.trim() === ""
                ? "（已手动中断本次生成）"
                : last.interaction !== undefined && last.content.trim() === ""
                  ? // 与后端落库的兜底文案一致：历史重载与实时表现相同。
                    "（已向你提问，请在上方卡片作答）"
                  : last.content,
          };
          return next;
        });
        interruptRequestedRef.current = false;
        setLiveAgent(null);
        setPlanView(null);
        break;
      case "error":
        patchLastAssistant({ status: "failed", error: event.message });
        setLiveAgent(null);
        setPlanView(null);
        break;
    }
  }

  async function send(text?: string): Promise<void> {
    // 显式传入 text 的路径（澄清选项 / 交互卡作答）不携带输入框里暂存的图片：
    // 那些图片属于用户正在编辑的这一轮。
    const outgoingImages = text === undefined ? pendingImages : [];
    // 只附图片也可以发送：补一句默认问题（后端 chat_ask 要求问题非空）。
    const question =
      (text ?? input).trim() || (outgoingImages.length > 0 ? "请分析这张图片。" : "");
    if (question === "" || busy) return;

    setInput("");
    localCounter.current += 1;
    setLiveAgent({ name: "chat 主力", action: "思考中…", step: 0 });
    setPlanView(null);

    // Resolve or create the target conversation first.
    let sid = activeId;
    try {
      if (sid === null) {
        // 非对话模式显式命名「摘要——类型」：后端只改默认名，显式命名
        // 不会被自动标题覆盖，主聊天侧栏与模式过滤都靠这个后缀。
        const created = await createSession(
          mode === "chat" ? undefined : `${chatTitlePrefix(question)}${MODE_SUFFIX[mode]}`,
        );
        sid = created.chatSessionId;
        setSessions((prev) => [created, ...prev]);
        setActiveId(sid);
      }
    } catch (err) {
      setLoadError(toErrorMessage(err));
      return;
    }

    // Optimistic user bubble; the pending assistant placeholder lives in
    // runTurn so retry can reuse the exact same streaming path.
    const stamp = `${Date.now()}-${localCounter.current}`;
    setMessages((prev) => [
      ...prev,
      { id: `local-user-${stamp}`, role: "user", content: question, status: "completed", sources: [], error: "", steps: [] },
    ]);
    const succeeded = await runTurn(
      sid,
      question,
      outgoingImages.map((image) => image.dataUrl),
    );
    // 发送成功才清空附件；失败保留，用户可直接重试（图片不落库）。
    if (succeeded) {
      setPendingImages([]);
      setImageError("");
    }
  }

  // 每轮渲染把最新闭包交给交互卡（见 sendRef 注释）。
  sendRef.current = send;
  busyRef.current = busy;

  /**
   * 流式执行一轮对话：插入 pending 占位、消费事件、失败标记。
   * `imageDataUrls` 是本轮用户主动附带的图片（data URL，仅本轮上下文有效，
   * 刷新 / 切会话不重放）；返回本轮是否成功完成，供调用方决定是否清空附件。
   */
  async function runTurn(
    targetId: string,
    question: string,
    imageDataUrls: string[] = [],
  ): Promise<boolean> {
    if (busy) return false;
    localCounter.current += 1;
    const stamp = `${Date.now()}-${localCounter.current}`;
    setMessages((prev) => [
      ...prev,
      { id: `local-assistant-${stamp}`, role: "assistant", content: "", status: "pending", sources: [], error: "", steps: [] },
    ]);
    setBusy(true);
    interruptRequestedRef.current = false;
    setStopping(false);

    const token = ++runToken.current;
    let succeeded = false;
    try {
      await chatAsk(
        targetId,
        question,
        (event) => {
          if (runToken.current === token) applyEvent(event);
        },
        chatProvider,
        attachedSkill?.folder ?? null,
        imageDataUrls,
      );
      // 技能是单次注入：随本轮发出后即清除（retry 不带技能）。
      setAttachedSkill(null);
      succeeded = true;
    } catch (err) {
      if (runToken.current === token) {
        patchLastAssistant({ status: "failed", error: toErrorMessage(err) });
      }
    } finally {
      if (runToken.current === token) setBusy(false);
      // Re-sort the sidebar so the active conversation floats to the top.
      void listSessions().then((rows) => setSessions(rows), () => undefined);
    }
    // 会话已切走（token 失效）时不算成功：不能清掉用户在新会话里暂存的附件。
    return succeeded && runToken.current === token;
  }

  /** 重试失败的回复：沿用其上方的用户消息，移除失败气泡后重新生成。 */
  function retry(messageId: string): void {
    if (busy || activeId === null) return;
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 1) return;
    const previous = messages[index - 1];
    if (previous.role !== "user") return;
    const question = previous.content.trim();
    if (question === "") return;
    setMessages((prev) => prev.slice(0, index));
    void runTurn(activeId, question);
  }

  /**
   * 编辑一条用户消息并重新发送（Gemini 式）：丢弃该消息及其后所有本地消息，
   * 以新文本开一轮。会话历史由后端另行追加，本轮不回删旧记录（与重试一致）。
   */
  function editResend(messageId: string, text: string): void {
    if (busy || activeId === null) return;
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    const question = text.trim();
    if (question === "") return;
    setMessages((prev) => prev.slice(0, index));
    void runTurn(activeId, question);
  }

  return (
    <div className={collapsed ? "chat-layout chat-layout--folded" : "chat-layout"}>
      <SessionSidebar
        sessions={visibleSessionRows(sessions, mode)}
        activeId={activeId}
        collapsed={collapsed}
        mode={mode}
        onSwitchMode={switchMode}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        onSelect={selectSession}
        onCreate={startDraft}
        onRename={(id, title) => void doRename(id, title)}
        onDelete={(id) => void removeSession(id)}
        onSummarize={(id) =>
          setSummaryTarget({
            id,
            title: sessions.find((s) => s.chatSessionId === id)?.title ?? "",
          })
        }
      />
      <div className="chat-main">
        {/* 顶栏：后台任务入口（独立任务不占用当前对话流）。 */}
        <div className="chat-topbar">
          <button
            type="button"
            className="chat-topbar__action"
            title="把一件独立工作交给后台 agent，不占用当前对话"
            onClick={() => setSpawnOpen(true)}
          >
            <span className="chat-topbar__icon" aria-hidden="true">
              <TaskIcon />
            </span>
            后台任务
          </button>
        </div>
        {/* key=mode：切换模式时消息区整棵重挂，触发 mode-in 过渡动画。 */}
        <MessageList
          key={mode}
          mode={mode}
          messages={messages}
          busy={busy}
          liveAgent={liveAgent}
          planView={planView}
          onSuggestion={(text) => setInput(text)}
          onRetry={retry}
          onEditResend={editResend}
          onAnswerInteraction={answerInteraction}
        />
        <div
          className={imageDragActive ? "composer-wrap composer-wrap--dragover" : "composer-wrap"}
          onDragEnter={handleImageDragEnter}
          onDragOver={handleImageDragOver}
          onDragLeave={handleImageDragLeave}
          onDrop={handleImageDrop}
        >
        {imageDragActive && (
          <p className="composer-drop-hint">松开即可添加图片（PNG / JPEG / WEBP / GIF，最多 4 张）</p>
        )}
        {loadError !== "" && <p className="error-text composer__error">{loadError}</p>}
        {clarifyVisible && clarify !== null && (
          <div className="clarify-bar" role="group" aria-label="澄清选项">
            <div className="clarify-bar__head">
              <span className="clarify-bar__badge" aria-hidden="true">
                ?
              </span>
              <span className="clarify-bar__question">
                {clarify.question !== "" ? clarify.question : "请选择一个方向继续，或直接输入说明"}
              </span>
              <button
                type="button"
                className="clarify-bar__dismiss"
                aria-label="收起选项"
                title="收起"
                onClick={() => setDismissedClarifyKey(clarifyKey)}
              >
                ✕
              </button>
            </div>
            <div className="clarify-bar__options">
              {clarify.options.map((option, index) => {
                const selected = index === pickedIndex;
                return (
                  <button
                    key={index}
                    type="button"
                    className={
                      selected
                        ? "clarify-bar__option clarify-bar__option--selected"
                        : "clarify-bar__option"
                    }
                    title="选中并填入输入框，可修改后回车发送"
                    onClick={() => pickClarifyOption(index, option)}
                  >
                    <span className="clarify-bar__num" aria-hidden="true">
                      {selected ? "✓" : index + 1}
                    </span>
                    <span className="clarify-bar__text">{option}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <ImageAttachmentStrip
          images={pendingImages}
          disabled={busy}
          onRemove={(id) => {
            setPendingImages((prev) => prev.filter((image) => image.id !== id));
            setImageError("");
          }}
        />
        {imageError !== "" && <p className="error-text composer__error">{imageError}</p>}
        {attachedSkill !== null && (
          <div className="skill-chip-row">
            <span className="skill-chip" title="该技能全文将随下一条消息强制注入">
              <span className="skill-chip__label">
                技能 · {attachedSkill.name}
                <span className="skill-chip__note">本轮强制注入</span>
              </span>
              <button
                type="button"
                className="skill-chip__remove"
                aria-label="移除技能"
                onClick={() => setAttachedSkill(null)}
              >
                ✕
              </button>
            </span>
          </div>
        )}
        <div className="composer">
          {skillMenu !== null && (
            <SkillMenu
              skills={filteredSkills}
              selectedIndex={menuIndex}
              onPick={pickSkill}
              onHover={(index) => setSkillMenu((prev) => prev && { ...prev, index })}
            />
          )}
          <textarea
            ref={inputRef}
            className="composer__input"
            rows={1}
            placeholder={
              busy
                ? "生成中，可继续输入下一问…"
                : activeId === null
                  ? "开始新对话…（输入 / 附加技能）"
                  : "输入问题，Enter 发送（/ 附加技能）"
            }
            value={input}
            onChange={(event) => {
              const value = event.target.value;
              setInput(value);
              if (value.startsWith("/")) {
                setSkillMenu((prev) => ({ query: value.slice(1), index: prev?.index ?? 0 }));
                // 懒刷新：菜单打开时拉最新技能清单（新放入的文件立即可见）。
                void listSkills().then(setAllSkills, () => undefined);
              } else {
                setSkillMenu(null);
              }
            }}
            onPaste={handleComposerPaste}
            onKeyDown={(event) => {
              if (skillMenu !== null) {
                if (event.key === "ArrowDown" && filteredSkills.length > 0) {
                  event.preventDefault();
                  setSkillMenu((prev) => prev && { ...prev, index: (menuIndex + 1) % filteredSkills.length });
                  return;
                }
                if (event.key === "ArrowUp" && filteredSkills.length > 0) {
                  event.preventDefault();
                  setSkillMenu((prev) => prev && { ...prev, index: (menuIndex - 1 + filteredSkills.length) % filteredSkills.length });
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSkillMenu(null);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  const picked = filteredSkills[menuIndex];
                  if (picked !== undefined) pickSkill(picked);
                  else setSkillMenu(null);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <input
            ref={imageInputRef}
            className="composer__image-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              // 清空 value：允许重复选择同一张图，下一次 change 仍会触发。
              event.target.value = "";
              void addImageFiles(files);
            }}
          />
          <button
            type="button"
            className="composer__attach"
            disabled={busy}
            aria-label="添加图片"
            title={busy ? "生成中，暂不能添加图片" : "添加图片（支持选择 / 粘贴 / 拖拽）"}
            onClick={() => imageInputRef.current?.click()}
          >
            <PaperclipIcon />
          </button>
          <div className="provider-picker" ref={pickerRef}>
            <button
              type="button"
              className="provider-icon"
              disabled={busy}
              aria-label="选择对话提供方"
              title={
                chatProvider === null
                  ? "对话提供方：默认（跟随 API 设置）"
                  : `对话提供方：${CHAT_PROVIDER_LABELS[chatProvider] ?? chatProvider}`
              }
              onClick={() => {
                setProviderMenuOpen((value) => !value);
                // 每次展开都重拉：在 API 设置里新配的 key 无需重进页面即可出现。
                void listProviders().then(
                  (statuses) => setProviderOptions(statuses.filter((p) => p.hasKey)),
                  () => undefined,
                );
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d="m12 3 9 5-9 5-9-5 9-5z" strokeLinejoin="round" />
                <path d="m3 12.5 9 5 9-5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="m3 17 9 5 9-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {chatProvider !== null && <span className="provider-icon__dot" aria-hidden="true" />}
            </button>
            {providerMenuOpen && (
              <div className="provider-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className={
                    chatProvider === null
                      ? "provider-menu__item provider-menu__item--active"
                      : "provider-menu__item"
                  }
                  onClick={() => {
                    setChatProvider(null);
                    setProviderMenuOpen(false);
                  }}
                >
                  默认（跟随 API 设置）
                </button>
                {providerOptions
                  .filter((p) => p.provider in CHAT_PROVIDER_LABELS)
                  .map((p) => (
                    <button
                      key={p.provider}
                      type="button"
                      role="menuitem"
                      className={
                        chatProvider === p.provider
                          ? "provider-menu__item provider-menu__item--active"
                          : "provider-menu__item"
                      }
                      onClick={() => {
                        setChatProvider(p.provider);
                        setProviderMenuOpen(false);
                      }}
                    >
                      {CHAT_PROVIDER_LABELS[p.provider] ?? p.provider}
                      {p.isDefault ? " · 默认" : ""}
                    </button>
                  ))}
                {providerOptions.filter((p) => p.provider in CHAT_PROVIDER_LABELS).length === 0 && (
                  <p className="provider-menu__empty">还没有已配置密钥的对话提供方</p>
                )}
              </div>
            )}
          </div>
          {busy ? (
            <button
              type="button"
              className="composer__send composer__send--stop"
              disabled={stopping || activeId === null}
              aria-label={stopping ? "正在中断" : "停止生成"}
              title={stopping ? "正在中断…" : "停止生成"}
              onClick={() => {
                if (activeId === null) return;
                interruptRequestedRef.current = true;
                setStopping(true);
                void stopChat(activeId).catch(() => {
                  interruptRequestedRef.current = false;
                  setStopping(false);
                });
              }}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              className={
                input.trim() === "" && pendingImages.length === 0
                  ? "composer__send composer__send--muted"
                  : "composer__send"
              }
              disabled={busy || (input.trim() === "" && pendingImages.length === 0)}
              aria-label={busy ? "生成中" : "发送"}
              title="Enter 发送 · Shift+Enter 换行"
              onClick={() => void send()}
            >
              <SendIcon />
            </button>
          )}
        </div>
        </div>
      </div>
      {summaryTarget !== null && (
        <SummaryModal
          sessionId={summaryTarget.id}
          sessionTitle={summaryTarget.title}
          onClose={() => setSummaryTarget(null)}
        />
      )}
      {spawnOpen && (
        <SpawnTaskModal sessionId={activeId} onClose={() => setSpawnOpen(false)} />
      )}
    </div>
  );
}

export default ChatView;
