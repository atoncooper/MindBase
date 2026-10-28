/**
 * 科研工作台 ↔ 主聊天 的共享状态。
 *
 * 控制台（ResearchView）只负责项目与阶段；AI 对话一律在主聊天（ChatView）
 * 中进行。两侧通过 localStorage + 自定义事件交换“当前科研项目”，
 * ChatView 再把项目简报随 chat_ask 发给后端。
 */

export const RESEARCH_CONTEXT_EVENT = "mb:research-context";

const ACTIVE_KEY = "mb.research.activeProjectId";
const PROMPT_KEY = "mb.research.pendingPrompt";

export function getActiveResearchProjectId(): string | null {
  try {
    const value = window.localStorage.getItem(ACTIVE_KEY);
    return value !== null && value.trim() !== "" ? value : null;
  } catch {
    return null;
  }
}

export function setActiveResearchProject(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(ACTIVE_KEY);
    else window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // localStorage 不可用时静默降级：本次会话仍可通过 pending prompt 跳转。
  }
  window.dispatchEvent(new CustomEvent(RESEARCH_CONTEXT_EVENT));
}

export function subscribeResearchContext(listener: () => void): () => void {
  const onCustom = (): void => listener();
  const onStorage = (event: StorageEvent): void => {
    if (event.key === ACTIVE_KEY) listener();
  };
  window.addEventListener(RESEARCH_CONTEXT_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(RESEARCH_CONTEXT_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

/** 控制台 → 主聊天的一次性输入草稿（打开聊天后自动填入输入框）。 */
export function setPendingResearchPrompt(prompt: string): void {
  try {
    window.sessionStorage.setItem(PROMPT_KEY, prompt);
  } catch {
    // 忽略：草稿不是关键路径。
  }
}

export function takePendingResearchPrompt(): string | null {
  try {
    const value = window.sessionStorage.getItem(PROMPT_KEY);
    if (value !== null) window.sessionStorage.removeItem(PROMPT_KEY);
    return value;
  } catch {
    return null;
  }
}

const NEW_CHAT_KEY = "mb.research.newChat";

/** 从控制台进入主聊天时强制新开草稿（不接续最近会话）。 */
export function setResearchNewChatFlag(): void {
  try {
    window.sessionStorage.setItem(NEW_CHAT_KEY, "1");
  } catch {
    // 忽略。
  }
}

export function takeResearchNewChatFlag(): boolean {
  try {
    const value = window.sessionStorage.getItem(NEW_CHAT_KEY);
    if (value !== null) window.sessionStorage.removeItem(NEW_CHAT_KEY);
    return value === "1";
  } catch {
    return false;
  }
}
