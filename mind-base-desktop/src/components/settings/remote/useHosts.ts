//! 远程主机配置控制器：列表/表单/保存/测试/复制/删除/指纹与项目绑定。
//!
//! 所有 ssh_hosts_* 与 ssh_host_* 命令集中在这里；展示组件只通过本控制器
//! 返回的状态与回调工作。

import { useEffect, useState } from "react";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import {
  forgetSshHostFingerprint,
  listSshHosts,
  saveSshHosts,
  testSshHost,
  trustSshHostFingerprint,
} from "../../../lib/ssh";
import type { SshHostConfig, SshSessionInfo, SshTestResult } from "../../../lib/ssh";
import { listResearchProjects } from "../../../lib/research";
import type { ResearchProject } from "../../../lib/research";
import { toErrorMessage } from "../../../lib/updater";
import { toItem } from "../../../lib/ui-state";
import type { Feedback, ItemState } from "../../../lib/ui-state";
import {
  EMPTY_DRAFT,
  draftFromHost,
  draftToHost,
  isFingerprintMismatch,
  validateDraft,
} from "./shared";
import type { FingerprintMismatch, HostDraft } from "./shared";

export interface UseHostsOptions {
  /** 当前会话（删除正在连接的主机前需要先断开）。 */
  getSession: () => SshSessionInfo | null;
  /** 指纹重置后重试连接（由会话控制器提供）。 */
  connect: (host: SshHostConfig) => Promise<void>;
  /** 断开当前会话（由会话控制器提供）。 */
  disconnect: () => Promise<void>;
}

/** 主机配置控制器返回值。 */
export interface HostsController {
  hosts: ItemState<SshHostConfig[]>;
  hostList: SshHostConfig[];
  selectedName: string | null;
  selectedHost: SshHostConfig | null;
  draft: HostDraft | null;
  isNew: boolean;
  search: string;
  setSearch: (value: string) => void;
  busy: boolean;
  feedback: Feedback;
  testing: boolean;
  testResult: { name: string; result: SshTestResult } | null;
  projects: ResearchProject[];
  fingerprintMismatch: FingerprintMismatch | null;
  resettingFingerprint: boolean;
  trustingFingerprint: boolean;
  fingerprintFeedback: Feedback;
  hostFingerprintBusy: string | null;
  hostFingerprintFeedback: Feedback;
  /** 启动引导：写入主机表并按活动会话/首台主机选中。 */
  applyBootstrap: (
    result: PromiseSettledResult<SshHostConfig[]>,
    liveHostName: string | null,
  ) => void;
  refreshHosts: () => Promise<void>;
  selectHost: (host: SshHostConfig) => void;
  startNew: () => void;
  updateDraft: (patch: Partial<HostDraft>) => void;
  /** 保存整表；true = 已成功保存（弹窗据此自动关闭）。 */
  handleSave: () => Promise<boolean>;
  /** 删除当前主机；true = 已删除。 */
  handleDelete: () => Promise<boolean>;
  handleDuplicate: () => Promise<void>;
  handleTest: () => Promise<void>;
  handlePickKey: () => Promise<void>;
  handleForgetFingerprint: () => Promise<void>;
  handleTrustTestFingerprint: () => Promise<void>;
  handleResetFingerprintAndRetry: (retry: "connect" | "test") => Promise<void>;
  handleResetHostFingerprint: (host: SshHostConfig) => Promise<void>;
  /** 连接失败时记录指纹不匹配提示（由会话控制器回调）。 */
  reportConnectError: (hostName: string, message: string) => void;
  /** 开始连接前清空指纹不匹配提示。 */
  clearConnectError: () => void;
  /** 开始连接前清空表单反馈（与旧实现一致）。 */
  clearFeedback: () => void;
  /** 关闭弹窗时丢弃未保存草稿：新建回到首台/无选中，编辑恢复 selectedHost。 */
  discardDraft: () => void;
}

export function useHosts(options: UseHostsOptions): HostsController {
  const { getSession, connect, disconnect } = options;
  const [hosts, setHosts] = useState<ItemState<SshHostConfig[]>>({ status: "loading" });
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [draft, setDraft] = useState<HostDraft | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ name: string; result: SshTestResult } | null>(
    null,
  );
  // 科研项目列表（绑定用）：加载失败静默，不影响远程设置本身。
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  // 指纹不匹配时的「重置指纹并重试」提示。
  const [fingerprintMismatch, setFingerprintMismatch] = useState<FingerprintMismatch | null>(null);
  const [resettingFingerprint, setResettingFingerprint] = useState(false);
  const [trustingFingerprint, setTrustingFingerprint] = useState(false);
  const [fingerprintFeedback, setFingerprintFeedback] = useState<Feedback>(null);
  // 主机指纹管理面板：逐行重置的忙碌态与结果提示。
  const [hostFingerprintBusy, setHostFingerprintBusy] = useState<string | null>(null);
  const [hostFingerprintFeedback, setHostFingerprintFeedback] = useState<Feedback>(null);

  const hostList = hosts.status === "ok" ? hosts.value : [];
  const selectedHost =
    selectedName === null ? null : (hostList.find((host) => host.name === selectedName) ?? null);

  // 科研项目列表：仅用于「绑定科研项目」下拉；加载失败静默（下拉只剩「未绑定」）。
  useEffect(() => {
    let cancelled = false;
    void listResearchProjects().then(
      (list) => {
        if (!cancelled) setProjects(list);
      },
      () => {
        // 静默：项目列表不可用不影响远程服务器配置本身。
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /** 启动引导：写入主机表，并按活动会话主机（否则首台主机）选中。 */
  function applyBootstrap(
    result: PromiseSettledResult<SshHostConfig[]>,
    liveHostName: string | null,
  ): void {
    setHosts(toItem(result));
    if (result.status !== "fulfilled") return;
    const list = result.value;
    const initial =
      liveHostName !== null ? (list.find((host) => host.name === liveHostName) ?? list[0]) : list[0];
    if (initial !== undefined) {
      setSelectedName(initial.name);
      setDraft(draftFromHost(initial));
    }
  }

  function selectHost(host: SshHostConfig): void {
    setSelectedName(host.name);
    setDraft(draftFromHost(host));
    setIsNew(false);
    setFeedback(null);
    setTestResult(null);
    setFingerprintMismatch(null);
    setFingerprintFeedback(null);
  }

  function startNew(): void {
    const used = hostList.map((host) => host.name);
    let name = "新会话";
    let index = 2;
    while (used.includes(name)) {
      name = "新会话 " + index;
      index += 1;
    }
    setSelectedName(null);
    setDraft({ ...EMPTY_DRAFT, name });
    setIsNew(true);
    setFeedback(null);
    setTestResult(null);
    setFingerprintMismatch(null);
    setFingerprintFeedback(null);
  }

  function updateDraft(patch: Partial<HostDraft>): void {
    setDraft((prev) => (prev === null ? prev : { ...prev, ...patch }));
  }

  /** 重新拉取主机表（TOFU/信任/重置指纹后同步 fingerprint 等后端写入的字段）。 */
  async function refreshHosts(): Promise<void> {
    try {
      const list = await listSshHosts();
      setHosts({ status: "ok", value: list });
    } catch {
      // 刷新失败不影响当前编辑；下次操作会再次读取。
    }
  }

  /** Persist the whole table (full replacement); null when the backend rejects. */
  async function persist(
    next: SshHostConfig[],
    successText: string,
  ): Promise<SshHostConfig[] | null> {
    setBusy(true);
    setFeedback(null);
    try {
      const stored = await saveSshHosts(next);
      setHosts({ status: "ok", value: stored });
      setFeedback({ kind: "ok", text: successText });
      return stored;
    } catch (err) {
      setFeedback({ kind: "error", text: "保存失败：" + toErrorMessage(err) });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleSave(): Promise<boolean> {
    if (draft === null || hosts.status !== "ok") return false;
    const error = validateDraft(draft, hosts.value, isNew ? null : selectedName);
    if (error !== null) {
      setFeedback({ kind: "error", text: error });
      return false;
    }
    // 指纹不在表单里编辑：沿用当前主机（后端会保留同名主机已有的非空指纹）。
    const host = draftToHost(draft, selectedHost?.fingerprint ?? "");
    const next = isNew
      ? [...hosts.value, host]
      : hosts.value.map((entry) => (entry.name === selectedName ? host : entry));
    const stored = await persist(
      next,
      isNew ? "✓ 已添加会话「" + host.name + "」" : "✓ 已保存会话「" + host.name + "」",
    );
    if (stored === null) return false;
    const saved = stored.find((entry) => entry.name === host.name) ?? null;
    if (saved !== null) {
      setSelectedName(saved.name);
      setDraft(draftFromHost(saved));
      setIsNew(false);
    }
    setTestResult(null);
    setFingerprintMismatch(null);
    setFingerprintFeedback(null);
    return true;
  }

  async function handleDelete(): Promise<boolean> {
    const host = selectedHost;
    if (host === null || hosts.status !== "ok" || busy) return false;
    const confirmed = await confirm("删除会话「" + host.name + "」？其保存的凭据会一并移除。", {
      title: "删除远程会话",
      kind: "warning",
    });
    if (!confirmed) return false;
    const session = getSession();
    if (session !== null && session.hostName === host.name) await disconnect();
    const stored = await persist(
      hosts.value.filter((entry) => entry.name !== host.name),
      "✓ 已删除会话「" + host.name + "」",
    );
    if (stored === null) return false;
    setTestResult(null);
    if (fingerprintMismatch !== null && fingerprintMismatch.name === host.name) {
      setFingerprintMismatch(null);
    }
    setFingerprintFeedback(null);
    const nextHost = stored[0] ?? null;
    if (nextHost !== null) {
      setSelectedName(nextHost.name);
      setDraft(draftFromHost(nextHost));
    } else {
      setSelectedName(null);
      setDraft(null);
    }
    setIsNew(false);
    return true;
  }

  async function handleDuplicate(): Promise<void> {
    const source = selectedHost;
    if (source === null || hosts.status !== "ok" || busy) return;
    const used = hosts.value.map((host) => host.name);
    let name = source.name + " 副本";
    let index = 2;
    while (used.includes(name)) {
      name = source.name + " 副本 " + index;
      index += 1;
    }
    const clone: SshHostConfig = { ...source, name };
    const stored = await persist([...hosts.value, clone], "✓ 已复制会话「" + source.name + "」");
    if (stored === null) return;
    const saved = stored.find((entry) => entry.name === name) ?? null;
    if (saved !== null) {
      setSelectedName(saved.name);
      setDraft(draftFromHost(saved));
      setIsNew(false);
      setTestResult(null);
    }
  }

  async function handleTest(): Promise<void> {
    const host = selectedHost;
    if (host === null || isNew || testing) return;
    setTesting(true);
    setTestResult(null);
    setFingerprintMismatch(null);
    try {
      const result = await testSshHost(host.name);
      setTestResult({ name: host.name, result });
      if (!result.ok && isFingerprintMismatch(result.message)) {
        setFingerprintMismatch({ name: host.name, message: result.message, retry: "test" });
      } else if (result.ok) {
        // 首次连接 TOFU：后端已写回指纹，同步一次主机表让 UI 显示「已固定」。
        void refreshHosts();
      }
    } catch (err) {
      const message = toErrorMessage(err);
      setTestResult({
        name: host.name,
        result: { ok: false, message, fingerprint: "", latencyMs: 0 },
      });
      if (isFingerprintMismatch(message)) {
        setFingerprintMismatch({ name: host.name, message, retry: "test" });
      }
    } finally {
      setTesting(false);
    }
  }

  /** 重置（忘记）当前主机已固定的指纹：下次连接重新 TOFU。 */
  async function handleForgetFingerprint(): Promise<void> {
    const host = selectedHost;
    if (host === null || resettingFingerprint) return;
    const confirmed = await confirm(
      "重置「" + host.name + "」已固定的服务器指纹？下次连接会重新记录并信任实际指纹。",
      { title: "重置主机指纹", kind: "warning" },
    );
    if (!confirmed) return;
    setResettingFingerprint(true);
    setFingerprintFeedback(null);
    try {
      const stored = await forgetSshHostFingerprint(host.name);
      setHosts({ status: "ok", value: stored });
      setFingerprintMismatch(null);
      setFingerprintFeedback({
        kind: "ok",
        text: "✓ 已重置指纹：下次连接会重新记录并信任服务器指纹",
      });
    } catch (err) {
      setFingerprintFeedback({ kind: "error", text: "重置指纹失败：" + toErrorMessage(err) });
    } finally {
      setResettingFingerprint(false);
    }
  }

  /** 信任「测试连接」返回的实际指纹（人工核对后固定，避免依赖下一次连接的 TOFU）。 */
  async function handleTrustTestFingerprint(): Promise<void> {
    const host = selectedHost;
    const fingerprint = testResult?.result.fingerprint ?? "";
    if (host === null || fingerprint === "" || trustingFingerprint) return;
    setTrustingFingerprint(true);
    setFingerprintFeedback(null);
    try {
      const stored = await trustSshHostFingerprint(host.name, fingerprint);
      setHosts({ status: "ok", value: stored });
      setFingerprintMismatch(null);
      setFingerprintFeedback({ kind: "ok", text: "✓ 已信任指纹：" + fingerprint });
    } catch (err) {
      setFingerprintFeedback({ kind: "error", text: "信任指纹失败：" + toErrorMessage(err) });
    } finally {
      setTrustingFingerprint(false);
    }
  }

  /** 指纹不匹配时：重置指纹后自动重试连接 / 测试。 */
  async function handleResetFingerprintAndRetry(retry: "connect" | "test"): Promise<void> {
    const host = selectedHost;
    if (host === null || resettingFingerprint) return;
    setResettingFingerprint(true);
    setFingerprintFeedback(null);
    try {
      const stored = await forgetSshHostFingerprint(host.name);
      setHosts({ status: "ok", value: stored });
      setFingerprintMismatch(null);
      setFingerprintFeedback({ kind: "ok", text: "✓ 已重置指纹" });
      if (retry === "connect") await connect(host);
      else await handleTest();
    } catch (err) {
      setFingerprintFeedback({ kind: "error", text: "重置指纹失败：" + toErrorMessage(err) });
    } finally {
      setResettingFingerprint(false);
    }
  }

  async function handlePickKey(): Promise<void> {
    if (draft === null) return;
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        title: "选择 SSH 私钥文件",
      });
      if (typeof picked !== "string" || picked === "") return;
      updateDraft({ keyPath: picked });
    } catch (err) {
      setFeedback({ kind: "error", text: "选择文件失败：" + toErrorMessage(err) });
    }
  }

  async function handleResetHostFingerprint(host: SshHostConfig): Promise<void> {
    if (hostFingerprintBusy !== null) return;
    const confirmed = await confirm(
      "重置「" + host.name + "」已固定的服务器指纹？下次连接会重新记录并信任实际指纹。",
      { title: "重置主机指纹", kind: "warning" },
    );
    if (!confirmed) return;
    setHostFingerprintBusy(host.name);
    setHostFingerprintFeedback(null);
    try {
      const stored = await forgetSshHostFingerprint(host.name);
      setHosts({ status: "ok", value: stored });
      if (fingerprintMismatch !== null && fingerprintMismatch.name === host.name) {
        setFingerprintMismatch(null);
      }
      setHostFingerprintFeedback({
        kind: "ok",
        text: "✓ 已重置「" + host.name + "」的指纹：下次连接重新 TOFU",
      });
    } catch (err) {
      setHostFingerprintFeedback({ kind: "error", text: "重置失败：" + toErrorMessage(err) });
    } finally {
      setHostFingerprintBusy(null);
    }
  }

  function reportConnectError(hostName: string, message: string): void {
    if (isFingerprintMismatch(message)) {
      setFingerprintMismatch({ name: hostName, message, retry: "connect" });
    }
  }

  function clearConnectError(): void {
    setFingerprintMismatch(null);
  }

  function clearFeedback(): void {
    setFeedback(null);
  }

  /** 关闭弹窗：丢弃未保存草稿（新建 → 首台/无选中；编辑 → 恢复 selectedHost）。 */
  function discardDraft(): void {
    if (isNew) {
      const first = hostList[0] ?? null;
      if (first !== null) {
        setSelectedName(first.name);
        setDraft(draftFromHost(first));
      } else {
        setSelectedName(null);
        setDraft(null);
      }
      setIsNew(false);
    } else if (selectedHost !== null) {
      setDraft(draftFromHost(selectedHost));
    } else {
      setDraft(null);
    }
    setFeedback(null);
    setTestResult(null);
    setFingerprintMismatch(null);
    setFingerprintFeedback(null);
  }

  return {
    hosts,
    hostList,
    selectedName,
    selectedHost,
    draft,
    isNew,
    search,
    setSearch,
    busy,
    feedback,
    testing,
    testResult,
    projects,
    fingerprintMismatch,
    resettingFingerprint,
    trustingFingerprint,
    fingerprintFeedback,
    hostFingerprintBusy,
    hostFingerprintFeedback,
    applyBootstrap,
    refreshHosts,
    selectHost,
    startNew,
    updateDraft,
    handleSave,
    handleDelete,
    handleDuplicate,
    handleTest,
    handlePickKey,
    handleForgetFingerprint,
    handleTrustTestFingerprint,
    handleResetFingerprintAndRetry,
    handleResetHostFingerprint,
    reportConnectError,
    clearConnectError,
    clearFeedback,
    discardDraft,
  };
}
