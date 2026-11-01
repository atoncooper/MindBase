//! SFTP 文件浏览器控制器：目录列表、路径导航、上传/下载、新建目录与删除。

import { useEffect, useRef, useState } from "react";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import {
  sftpDelete,
  sftpDownload,
  sftpList,
  sftpMkdir,
  sftpUpload,
} from "../../../lib/ssh";
import type { SftpEntry, SshHostConfig, SshSessionInfo } from "../../../lib/ssh";
import { toErrorMessage } from "../../../lib/updater";
import {
  baseName,
  formatBytes,
  joinRemotePath,
  parentRemotePath,
} from "./shared";
import type { RightTab } from "./shared";

export interface UseSftpOptions {
  session: SshSessionInfo | null;
  rightTab: RightTab;
  hostList: SshHostConfig[];
}

/** SFTP 控制器返回值。 */
export interface SftpController {
  sftpPath: string;
  sftpPathDraft: string;
  sftpEntries: SftpEntry[];
  sftpLoading: boolean;
  sftpBusy: boolean;
  sftpError: string | null;
  sftpNotice: string | null;
  newDirOpen: boolean;
  newDirName: string;
  setSftpPathDraft: (value: string) => void;
  setNewDirName: (value: string) => void;
  loadSftp: (path: string) => Promise<void>;
  enterSftpDirectory: (entry: SftpEntry) => void;
  goSftpParent: () => void;
  handleSftpUpload: () => Promise<void>;
  handleSftpDownload: (entry: SftpEntry) => Promise<void>;
  handleSftpMkdir: () => Promise<void>;
  handleSftpDelete: (entry: SftpEntry) => Promise<void>;
  toggleNewDir: () => void;
  cancelNewDir: () => void;
}

export function useSftp(options: UseSftpOptions): SftpController {
  const { session, rightTab, hostList } = options;
  const [sftpPath, setSftpPath] = useState("/");
  const [sftpPathDraft, setSftpPathDraft] = useState("/");
  const sftpPathRef = useRef("/");
  const sessionRef = useRef<string | null>(null);
  const [sftpEntries, setSftpEntries] = useState<SftpEntry[]>([]);
  const [sftpLoading, setSftpLoading] = useState(false);
  const [sftpBusy, setSftpBusy] = useState(false);
  const [sftpError, setSftpError] = useState<string | null>(null);
  const [sftpNotice, setSftpNotice] = useState<string | null>(null);
  const [newDirOpen, setNewDirOpen] = useState(false);
  const [newDirName, setNewDirName] = useState("");

  useEffect(() => {
    sessionRef.current = session?.sessionId ?? null;
  }, [session?.sessionId]);

  // 会话切换：重置 SFTP 状态，并把文件浏览起点指向主机默认远程目录。
  useEffect(() => {
    if (session === null) {
      sftpPathRef.current = "/";
      setSftpPath("/");
      setSftpPathDraft("/");
      setSftpEntries([]);
      setSftpError(null);
      setSftpNotice(null);
      setNewDirOpen(false);
      setNewDirName("");
      return;
    }
    const host = hostList.find((entry) => entry.name === session.hostName) ?? null;
    const remoteDir = host === null ? "" : (host.remoteDir ?? "").trim();
    const initial = remoteDir === "" ? "/" : remoteDir;
    sftpPathRef.current = initial;
    setSftpPath(initial);
    setSftpPathDraft(initial);
    setSftpEntries([]);
    setSftpError(null);
    setSftpNotice(null);
  }, [session?.sessionId]);

  // 切到「文件」tab 时按当前远端目录加载一次 SFTP 列表。
  useEffect(() => {
    if (rightTab !== "files" || session === null) return;
    void loadSftp(sftpPathRef.current);
  }, [rightTab, session?.sessionId]);

  /** 加载远端目录（成功时同步路径输入框；失败保留当前目录）。 */
  async function loadSftp(path: string): Promise<void> {
    const sessionId = sessionRef.current;
    if (sessionId === null) return;
    const target = path.trim() === "" ? "/" : path.trim();
    setSftpLoading(true);
    setSftpError(null);
    try {
      const entries = await sftpList(sessionId, target);
      // 个别 SFTP 服务端会返回 . / .. 伪目录，交给「上一级」按钮处理即可。
      setSftpEntries(entries.filter((entry) => entry.name !== "." && entry.name !== ".."));
      sftpPathRef.current = target;
      setSftpPath(target);
      setSftpPathDraft(target);
    } catch (err) {
      setSftpError(toErrorMessage(err));
    } finally {
      setSftpLoading(false);
    }
  }

  function enterSftpDirectory(entry: SftpEntry): void {
    if (!entry.isDir || sftpLoading) return;
    setNewDirOpen(false);
    void loadSftp(entry.path);
  }

  function goSftpParent(): void {
    if (sftpLoading) return;
    setNewDirOpen(false);
    void loadSftp(parentRemotePath(sftpPath));
  }

  async function handleSftpUpload(): Promise<void> {
    const sessionId = sessionRef.current;
    if (sessionId === null || sftpBusy) return;
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        title: "选择要上传到远端的文件",
      });
      if (typeof picked !== "string" || picked === "") return;
      const name = baseName(picked);
      if (name === "") return;
      setSftpBusy(true);
      setSftpError(null);
      setSftpNotice(null);
      const result = await sftpUpload(sessionId, picked, joinRemotePath(sftpPath, name));
      setSftpNotice("✓ 已上传 " + name + "（" + formatBytes(result.bytes) + "）");
      await loadSftp(sftpPath);
    } catch (err) {
      setSftpError("上传失败：" + toErrorMessage(err));
    } finally {
      setSftpBusy(false);
    }
  }

  async function handleSftpDownload(entry: SftpEntry): Promise<void> {
    const sessionId = sessionRef.current;
    if (sessionId === null || sftpBusy || entry.isDir) return;
    try {
      const target = await save({ title: "下载到本机", defaultPath: entry.name });
      if (typeof target !== "string" || target === "") return;
      setSftpBusy(true);
      setSftpError(null);
      setSftpNotice(null);
      const result = await sftpDownload(sessionId, entry.path, target);
      setSftpNotice("✓ 已下载 " + entry.name + "（" + formatBytes(result.bytes) + "）");
    } catch (err) {
      setSftpError("下载失败：" + toErrorMessage(err));
    } finally {
      setSftpBusy(false);
    }
  }

  async function handleSftpMkdir(): Promise<void> {
    const sessionId = sessionRef.current;
    const name = newDirName.trim();
    if (sessionId === null || sftpBusy) return;
    if (name === "") {
      setSftpError("请填写目录名");
      return;
    }
    if (name.includes("/") || name.includes("\\")) {
      setSftpError("目录名不能包含路径分隔符");
      return;
    }
    setSftpBusy(true);
    setSftpError(null);
    setSftpNotice(null);
    try {
      await sftpMkdir(sessionId, joinRemotePath(sftpPath, name));
      setSftpNotice("✓ 已创建目录 " + name);
      setNewDirOpen(false);
      setNewDirName("");
      await loadSftp(sftpPath);
    } catch (err) {
      setSftpError("新建目录失败：" + toErrorMessage(err));
    } finally {
      setSftpBusy(false);
    }
  }

  async function handleSftpDelete(entry: SftpEntry): Promise<void> {
    const sessionId = sessionRef.current;
    if (sessionId === null || sftpBusy || entry.isDir) return;
    const confirmed = await confirm("删除远端文件「" + entry.path + "」？该操作不可恢复。", {
      title: "删除远端文件",
      kind: "warning",
    });
    if (!confirmed) return;
    setSftpBusy(true);
    setSftpError(null);
    setSftpNotice(null);
    try {
      await sftpDelete(sessionId, entry.path);
      setSftpNotice("✓ 已删除 " + entry.name);
      await loadSftp(sftpPath);
    } catch (err) {
      setSftpError("删除失败：" + toErrorMessage(err));
    } finally {
      setSftpBusy(false);
    }
  }

  function toggleNewDir(): void {
    setNewDirOpen((openState) => !openState);
    setNewDirName("");
  }

  function cancelNewDir(): void {
    setNewDirOpen(false);
    setNewDirName("");
  }

  return {
    sftpPath,
    sftpPathDraft,
    sftpEntries,
    sftpLoading,
    sftpBusy,
    sftpError,
    sftpNotice,
    newDirOpen,
    newDirName,
    setSftpPathDraft,
    setNewDirName,
    loadSftp,
    enterSftpDirectory,
    goSftpParent,
    handleSftpUpload,
    handleSftpDownload,
    handleSftpMkdir,
    handleSftpDelete,
    toggleNewDir,
    cancelNewDir,
  };
}
