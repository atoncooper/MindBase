//! 远程服务器设置页的共享类型与纯函数（无 React / 无 invoke）。
//!
//! 供 use* 控制器与展示组件复用：表单草稿转换、校验、路径/大小/时间格式化、
//! 指纹与绑定项目的展示辅助、剪贴板兜底等。

import type { SshHostConfig, SshTestResult } from "../../../lib/ssh";
import type { ResearchProject } from "../../../lib/research";

/** 终端连接状态（连接中时禁止重复点击）。 */
export type ConnState = "disconnected" | "connecting" | "connected";

/** 右侧面板 tab：终端 / 文件（SFTP）/ 端口转发 / 主机指纹。 */
export type RightTab = "terminal" | "files" | "forwards" | "hosts";

export const RIGHT_TABS: ReadonlyArray<{ id: RightTab; label: string }> = [
  { id: "terminal", label: "终端" },
  { id: "files", label: "文件" },
  { id: "forwards", label: "转发" },
  { id: "hosts", label: "主机指纹" },
];

/** TerminalPanel 暴露给会话控制器的命令式接口（xterm 生命周期留在面板内）。 */
export interface TerminalPanelHandle {
  /** 连接前：清空缓存、标记 connecting、reset + fit。 */
  prepareConnect(): void;
  /** 连接结束（成功或失败）后清除 connecting 标记。 */
  finishConnect(): void;
  /** 同步当前会话 id（事件分发 + 回放连接期间缓存的输出）。 */
  setSessionId(sessionId: string | null): void;
  /** 取出并清空「连接期间收到 ssh-closed」的缓存（连接成功后立即判定）。 */
  consumePendingClosed(sessionId: string): { sessionId: string; reason: string } | null;
  /** 向终端追加一行（连接失败/断开提示等）。 */
  writeLine(text: string): void;
}

/** 表单草稿：端口用字符串承接输入，提交时再校验成数字。 */
export interface HostDraft {
  name: string;
  host: string;
  port: string;
  username: string;
  auth: "password" | "key";
  password: string;
  keyPath: string;
  passphrase: string;
  remoteDir: string;
  /** 绑定的科研项目 id（空 = 未绑定）。 */
  projectId: string;
  /** 是否允许 Agent 使用该主机。 */
  allowAgent: boolean;
  /** 是否把交互会话输出记录到本机日志。 */
  logSession: boolean;
}

export const EMPTY_DRAFT: HostDraft = {
  name: "",
  host: "",
  port: "22",
  username: "root",
  auth: "password",
  password: "",
  keyPath: "",
  passphrase: "",
  remoteDir: "",
  projectId: "",
  allowAgent: false,
  logSession: false,
};

export function draftFromHost(host: SshHostConfig): HostDraft {
  return {
    name: host.name,
    host: host.host,
    port: String(host.port),
    username: host.username,
    auth: host.auth === "key" ? "key" : "password",
    password: host.password ?? "",
    keyPath: host.keyPath ?? "",
    passphrase: host.passphrase ?? "",
    remoteDir: host.remoteDir ?? "",
    projectId: host.projectId ?? "",
    allowAgent: host.allowAgent === true,
    logSession: host.logSession === true,
  };
}

/** Validate the draft; null means OK. Names are the host identity. */
export function validateDraft(
  draft: HostDraft,
  hosts: SshHostConfig[],
  editingName: string | null,
): string | null {
  const name = draft.name.trim();
  if (name === "") return "请填写会话名称";
  if (name !== editingName && hosts.some((host) => host.name === name)) {
    return "名称「" + name + "」已存在";
  }
  if (draft.host.trim() === "") return "请填写主机地址";
  if (draft.username.trim() === "") return "请填写用户名";
  const port = Number(draft.port.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "端口需为 1-65535 的整数";
  }
  if (draft.auth === "password" && draft.password === "") {
    return "密码认证需要填写登录密码";
  }
  if (draft.auth === "key" && draft.keyPath.trim() === "") {
    return "密钥认证需要选择 PEM 私钥文件";
  }
  return null;
}

/**
 * Normalize the draft into the persisted shape (unused secrets are dropped).
 * fingerprint 不在表单里编辑，保存时沿用后端当前值，避免把 TOFU 刚记录的指纹清空。
 */
export function draftToHost(draft: HostDraft, fingerprint: string): SshHostConfig {
  return {
    name: draft.name.trim(),
    host: draft.host.trim(),
    port: Number(draft.port.trim()),
    username: draft.username.trim(),
    auth: draft.auth,
    password: draft.auth === "password" ? draft.password : "",
    keyPath: draft.auth === "key" ? draft.keyPath.trim() : "",
    passphrase: draft.auth === "key" ? draft.passphrase : "",
    remoteDir: draft.remoteDir.trim(),
    fingerprint,
    projectId: draft.projectId,
    allowAgent: draft.allowAgent,
    logSession: draft.logSession,
  };
}

/** Inline text for a test result: success shows latency + fingerprint. */
export function testSummary(result: SshTestResult): string {
  if (!result.ok) return result.message !== "" ? result.message : "连接失败";
  const parts: string[] = [];
  if (Number.isFinite(result.latencyMs)) parts.push(result.latencyMs + " ms");
  if (result.fingerprint !== "") parts.push(result.fingerprint);
  if (result.message !== "") parts.push(result.message);
  return parts.join(" · ");
}

/** 后端指纹不匹配错误里固定包含「指纹不匹配」，用于提示重置并重试。 */
export function isFingerprintMismatch(message: string): boolean {
  return message.includes("指纹不匹配");
}

/** 已固定的主机指纹（旧后端/空值为空串）。 */
export function pinnedFingerprint(host: SshHostConfig): string {
  return host.fingerprint ?? "";
}

/** 绑定项目的展示名：已知项目用标题，未知（项目列表加载失败/已删除）回退 id。 */
export function projectLabel(projects: ResearchProject[], projectId: string): string {
  if (projectId === "") return "";
  const found = projects.find((project) => project.id === projectId);
  return found === undefined ? projectId : found.title;
}

/** 指纹不匹配后的重试动作：连接失败或测试失败。 */
export interface FingerprintMismatch {
  name: string;
  message: string;
  retry: "connect" | "test";
}

/** 拼接远端 POSIX 路径。 */
export function joinRemotePath(dir: string, name: string): string {
  if (dir === "" || dir === "/") return "/" + name;
  return dir.endsWith("/") ? dir + name : dir + "/" + name;
}

/** 上级远端目录（根目录返回自身）。 */
export function parentRemotePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return "/";
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

/** 本地路径的文件名（兼容 Windows 反斜杠）。 */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/** 人类可读的文件大小。 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return size + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + " " + units[unit];
}

/** 远端修改时间（epoch 秒 → 本地时间，0 显示破折号）。 */
export function formatRemoteTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  const date = new Date(timestamp * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

/** Tauri WebView 下剪贴板权限不稳，统一带 execCommand 兜底。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }
}
