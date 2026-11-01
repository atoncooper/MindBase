/**
 * Typed access to the SSH remote-host settings (Rust `ssh_hosts_*` /
 * `ssh_host_test` commands).
 *
 * The host table lives in the local config; credentials (password / private
 * key path / passphrase) never leave this machine. The agent's remote tools
 * read the same table and refuse dangerous commands via a blocklist
 * (`<data dir>/command-blocklist.json` overrides the built-in rules).
 */

import { invoke } from "@tauri-apps/api/core";

/** One SSH host entry (mirrors the Rust `SshHostConfig`). */
export interface SshHostConfig {
  /** Unique display name; also the identity accepted by `testSshHost`. */
  name: string;
  /** Hostname or IP address. */
  host: string;
  /** SSH port (defaults to 22). */
  port: number;
  /** Login user. */
  username: string;
  /** `"password"` uses `password`; `"key"` uses `keyPath` + `passphrase`. */
  auth: "password" | "key";
  /** Password for password auth (stored locally only). */
  password: string;
  /** Private-key file path (PEM / OpenSSH) for key auth. */
  keyPath: string;
  /** Optional passphrase protecting the private key. */
  passphrase: string;
  /** Optional default working directory for remote commands. */
  remoteDir: string;
  /**
   * Pinned server host-key fingerprint (SHA256:...); empty means the host has
   * not been trusted yet (the first interactive connection records it).
   */
  fingerprint: string;
  /** Bound research project id; empty means unbound. */
  projectId: string;
  /** Whether the agent may use this host (only for bound + trusted hosts). */
  allowAgent: boolean;
  /** Record the interactive session output to <data dir>/logs/ssh/. */
  logSession: boolean;
}

/** Outcome of `ssh_host_test`: latency + host-key fingerprint on success. */
export interface SshTestResult {
  ok: boolean;
  /** Human-readable detail; the failure reason when `ok` is false. */
  message: string;
  /** Server host-key fingerprint (empty when unknown / failed). */
  fingerprint: string;
  /** Round-trip time in milliseconds. */
  latencyMs: number;
}

/** One live interactive SSH session (mirrors the Rust `SshSessionInfo`). */
export interface SshSessionInfo {
  /** Opaque session id used by write/resize/disconnect. */
  sessionId: string;
  /** Configured host name the session was opened for. */
  hostName: string;
  host: string;
  port: number;
  username: string;
  /** Backend timestamp (Unix epoch seconds). */
  connectedAt: number;
  /** Local session-log path; empty when `logSession` is off. */
  logPath: string;
}

/** Payload of the `ssh-output` event (PTY stdout/stderr chunks). */
export interface SshOutputEvent {
  sessionId: string;
  /** Raw bytes decoded by the backend; feed straight into xterm. */
  data: string;
  stream: "stdout" | "stderr";
}

/** Payload of the `ssh-closed` event (EOF / error / remote close). */
export interface SshClosedEvent {
  sessionId: string;
  /** Human-readable close reason (empty on a clean remote exit). */
  reason: string;
}

/** One entry in a remote directory (returned by `sftp_list`). */
export interface SftpEntry {
  name: string;
  /** Absolute remote path (POSIX separators). */
  path: string;
  isDir: boolean;
  /** File size in bytes (0 for directories). */
  size: number;
  /** Unix epoch seconds; 0 when unknown. */
  modifiedAt: number;
}

/** Result of a completed SFTP upload/download. */
export interface SftpTransferResult {
  bytes: number;
}

/** One active local port forward of an interactive session. */
export interface SshForwardInfo {
  id: string;
  /** Local listening port on 127.0.0.1. */
  localPort: number;
  /** Remote target host. */
  remoteHost: string;
  remotePort: number;
  /** Unix epoch seconds. */
  createdAt: number;
}

/** Read the configured SSH hosts (empty when none are configured). */
export function listSshHosts(): Promise<SshHostConfig[]> {
  return invoke<SshHostConfig[]>("ssh_hosts_list");
}

/** Persist the whole host table and return the stored value. */
export function saveSshHosts(hosts: SshHostConfig[]): Promise<SshHostConfig[]> {
  return invoke<SshHostConfig[]>("ssh_hosts_save", { hosts });
}

/**
 * Test connectivity for the persisted host named `name` (save edits first).
 * Rejects only on transport-level failures; a failed handshake resolves with
 * `ok: false` and a readable `message`.
 */
export function testSshHost(name: string): Promise<SshTestResult> {
  return invoke<SshTestResult>("ssh_host_test", { name });
}

/**
 * Pin (trust) a server host-key fingerprint for the persisted host name.
 *
 * Used after the user verifies a new/changed fingerprint; the next connection
 * compares against this value and refuses a mismatch (MITM protection).
 * Resolves with the updated (decrypted) host table, ready to refresh the UI.
 */
export function trustSshHostFingerprint(
  name: string,
  fingerprint: string,
): Promise<SshHostConfig[]> {
  return invoke<SshHostConfig[]>("ssh_host_trust_fingerprint", { name, fingerprint });
}

/**
 * Forget the pinned fingerprint of a host: the next interactive connection
 * records and trusts the actual fingerprint again (TOFU). Resolves with the
 * updated (decrypted) host table.
 */
export function forgetSshHostFingerprint(name: string): Promise<SshHostConfig[]> {
  return invoke<SshHostConfig[]>("ssh_host_forget_fingerprint", { name });
}

// --- 交互式终端会话 ---------------------------------------------------------

/**
 * Open an interactive PTY shell for the persisted host `name`.
 *
 * Rejects with a readable Chinese message when the host is unknown or the
 * connection / authentication fails. On success the backend starts emitting
 * `ssh-output` / `ssh-closed` events for the returned session id.
 */
export function connectSshHost(name: string): Promise<SshSessionInfo> {
  return invoke<SshSessionInfo>("ssh_connect", { name });
}

/** Send raw terminal input (keystrokes incl. \r) to the session. */
export function writeSsh(sessionId: string, data: string): Promise<void> {
  return invoke<void>("ssh_write", { sessionId, data });
}

/** Propagate a terminal resize (columns / rows) to the remote PTY. */
export function resizeSsh(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke<void>("ssh_resize", { sessionId, cols, rows });
}

/** Close one interactive session (no-op if it already ended). */
export function disconnectSsh(sessionId: string): Promise<void> {
  return invoke<void>("ssh_disconnect", { sessionId });
}

/** List the sessions that are currently alive on the backend. */
export function listSshSessions(): Promise<SshSessionInfo[]> {
  return invoke<SshSessionInfo[]>("ssh_sessions_list");
}

// --- SFTP 文件传输 ----------------------------------------------------------

/** List one remote directory (directories first, sorted by name). */
export function sftpList(sessionId: string, path: string): Promise<SftpEntry[]> {
  return invoke<SftpEntry[]>("sftp_list", { sessionId, path });
}

/** Download a remote file to a local path (parent directory auto-created). */
export function sftpDownload(
  sessionId: string,
  remotePath: string,
  localPath: string,
): Promise<SftpTransferResult> {
  return invoke<SftpTransferResult>("sftp_download", { sessionId, remotePath, localPath });
}

/** Upload a local file to a remote path (the remote directory must exist). */
export function sftpUpload(
  sessionId: string,
  localPath: string,
  remotePath: string,
): Promise<SftpTransferResult> {
  return invoke<SftpTransferResult>("sftp_upload", { sessionId, localPath, remotePath });
}

/** Create one remote directory. */
export function sftpMkdir(sessionId: string, path: string): Promise<void> {
  return invoke<void>("sftp_mkdir", { sessionId, path });
}

/** Delete one remote file (directories are rejected by the backend). */
export function sftpDelete(sessionId: string, path: string): Promise<void> {
  return invoke<void>("sftp_delete", { sessionId, path });
}

// --- 本地端口转发（127.0.0.1:localPort → remoteHost:remotePort） ------------

/** Add one local port forward to an interactive session. */
export function addSshForward(
  sessionId: string,
  localPort: number,
  remoteHost: string,
  remotePort: number,
): Promise<SshForwardInfo> {
  return invoke<SshForwardInfo>("ssh_forward_add", {
    sessionId,
    localPort,
    remoteHost,
    remotePort,
  });
}

/** Remove one local port forward (releases the local port). */
export function removeSshForward(sessionId: string, forwardId: string): Promise<void> {
  return invoke<void>("ssh_forward_remove", { sessionId, forwardId });
}

/** List the active local port forwards of one session. */
export function listSshForwards(sessionId: string): Promise<SshForwardInfo[]> {
  return invoke<SshForwardInfo[]>("ssh_forward_list", { sessionId });
}
