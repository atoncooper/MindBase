// 沙箱管理 API：前端只与 app-admin 代理的 /api/sandbox/* 交互。
//
// 组件禁止直接 fetch —— 全部经 ../api/client 的 request/post/qs：
//   · session cookie 鉴权（credentials: include）、401 统一清态跳登录；
//   · 错误契约 {detail: string} 由 client 转成 ApiError（message 即 detail）；
//   · uid 是 bigint（> 2^53），client 在 JSON.parse 前把 ≥16 位数字字面量保留为
//     字符串，故类型为 number | string，仅用于展示/查询串，不做数值运算。

import { post, qs, request } from "./client";

/** uid 运行时可能是 number 或 string（见文件头 bigint 说明）。 */
export type SandboxUid = number | string;

/** 统一分页响应（契约 §三：page 从 1 起、pageSize 1..100，默认 20）。 */
export interface SandboxPaged<T> {
  items: T[];
  total: number;
  page?: number;
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// 概览
// ---------------------------------------------------------------------------

/** 租约状态计数（状态机：creating→ready→busy→idle→releasing→terminated/failed）。 */
export interface SandboxLeaseCounts {
  creating: number;
  ready: number;
  busy: number;
  idle: number;
  releasing: number;
  terminated: number;
  failed: number;
  total: number;
}

/** 执行状态计数（注意：终端超时状态在控制层是 "timeout"，概览计数键为 timed_out）。 */
export interface SandboxExecutionCounts {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  timed_out: number;
  canceled: number;
  total: number;
}

export interface SandboxOverview {
  leases: SandboxLeaseCounts;
  executions: SandboxExecutionCounts;
  last24h: { executions: number; failures: number };
  quotaEnabled: boolean;
}

// ---------------------------------------------------------------------------
// 执行记录
// ---------------------------------------------------------------------------

export interface SandboxExecutionItem {
  id: string;
  uid: SandboxUid;
  projectId: string;
  language: string;
  /** queued / running / succeeded / failed / timeout / canceled */
  status: string;
  exitCode?: number | null;
  durationMs?: number | null;
  leaseId: string;
  errorCode?: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  artifactCount?: number;
  artifactBytes?: number;
  /** 截断预览（控制层 previewBytes 上限；不含完整代码正文） */
  stdoutPreview?: string;
  stderrPreview?: string;
}

/** 产物元数据（对象字节在 MinIO；前端只展示元信息，不提供下载）。 */
export interface SandboxArtifactItem {
  id?: string;
  name: string;
  sizeBytes?: number;
  sha256?: string;
  contentType?: string;
  createdAt?: string;
}

/** 审计记录（沙箱控制层 audit；与后台自身审计日志是两套，双留痕）。 */
export interface SandboxAuditItem {
  id: string;
  uid: SandboxUid;
  action: string;
  /** 动作发起者：agent / user / system / admin（控制层 1.0.19 起写入） */
  actor?: string;
  executionId?: string;
  leaseId?: string;
  projectId?: string;
  image?: string;
  outcome?: string;
  durationMs?: number | null;
  exitCode?: number | null;
  detail?: string;
  requestId?: string;
  createdAt: string;
}

/**
 * 执行详情 = 列表视图 + 产物元数据 + 审计时间线。
 * 契约 §三只说「预览、产物元数据、审计事件」，未固定后两者字段名：这里同时接受
 * audit / events 两种上游命名，避免与并行落地的 Go handler 命名不一致时页面空白。
 */
export interface SandboxExecutionDetail extends SandboxExecutionItem {
  artifacts?: SandboxArtifactItem[];
  audit?: SandboxAuditItem[];
  events?: SandboxAuditItem[];
}

// ---------------------------------------------------------------------------
// 租约
// ---------------------------------------------------------------------------

export interface SandboxLeaseItem {
  id: string;
  uid: SandboxUid;
  projectId: string;
  purpose: string;
  state: string;
  runtime: string;
  runtimeId: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
}

// ---------------------------------------------------------------------------
// 配额 / 配置
// ---------------------------------------------------------------------------

/** 四个固定配额维度（与 app-sandbox config.QuotaKinds 一致；-1 表示不限）。 */
export interface SandboxQuotaLimits {
  academic_run?: number;
  sandbox_concurrent?: number;
  sandbox_cpu_seconds?: number;
  sandbox_artifact_bytes?: number;
}

export interface SandboxQuotaView {
  uid: SandboxUid;
  /** 业务本地日期 YYYY-MM-DD */
  day: string;
  executions: number;
  cpuMillis: number;
  artifactBytes: number;
  /** free / vip / svip */
  tier: string;
  limits: SandboxQuotaLimits;
}

/** 运行时配置只读摘要（控制层 /internal/admin/config；字段全部可选以容错）。 */
export interface SandboxConfigView {
  runtime?: string;
  image?: string;
  resources?: { cpu?: string; memory?: string };
  leaseTtlSeconds?: number;
  admission?: {
    maxConcurrent?: number;
    maxPerUid?: number;
    queueSize?: number;
    queueTimeoutMs?: number;
  };
  quotaEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// 查询参数
// ---------------------------------------------------------------------------

/** 查询串参数：带索引签名以便直接交给 client 的 qs()。 */
export interface SandboxExecutionQuery {
  uid?: string;
  projectId?: string;
  status?: string;
  /** RFC3339 时间（起/止） */
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
  [key: string]: string | number | undefined;
}

export interface SandboxLeaseQuery {
  uid?: string;
  state?: string;
  page?: number;
  pageSize?: number;
  [key: string]: string | number | undefined;
}

export interface SandboxAuditQuery {
  uid?: string;
  action?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
  [key: string]: string | number | undefined;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** app-admin 代理端点（viewer 可读；cancel/release 仅 admin，由后端 403 兜底）。 */
export const sandboxApi = {
  overview: () => request<SandboxOverview>("/api/sandbox/overview"),
  config: () => request<SandboxConfigView>("/api/sandbox/config"),

  executions: (params: SandboxExecutionQuery) =>
    request<SandboxPaged<SandboxExecutionItem>>(`/api/sandbox/executions${qs(params)}`),
  execution: (id: string) =>
    request<SandboxExecutionDetail>(`/api/sandbox/executions/${encodeURIComponent(id)}`),
  cancelExecution: (id: string) =>
    post<void>(`/api/sandbox/executions/${encodeURIComponent(id)}/cancel`),

  leases: (params: SandboxLeaseQuery) =>
    request<SandboxPaged<SandboxLeaseItem>>(`/api/sandbox/leases${qs(params)}`),
  releaseLease: (id: string) => post<void>(`/api/sandbox/leases/${encodeURIComponent(id)}/release`),

  quota: (params: { uid: string; day?: string }) =>
    request<SandboxQuotaView>(`/api/sandbox/quota${qs(params)}`),

  audit: (params: SandboxAuditQuery) =>
    request<SandboxPaged<SandboxAuditItem>>(`/api/sandbox/audit${qs(params)}`),
};
