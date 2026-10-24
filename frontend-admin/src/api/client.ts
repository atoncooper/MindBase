import type {
  AuditItem,
  LoginResult,
  MeInfo,
  Paged,
  PreviewGrant,
  ShareDetail,
  ShareItem,
  UserDetail,
  UserItem,
  UserQueryMode,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** 由 App 在路由上下文内注册：401 时清登录态并跳 /login */
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
  unauthorizedHandler = fn;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(path, {
      credentials: "include",
      ...init,
      headers: init.body
        ? { "Content-Type": "application/json", ...(init.headers ?? {}) }
        : init.headers,
    });
  } catch {
    throw new ApiError(0, "网络错误：无法连接管理后端");
  }

  if (resp.status === 401) {
    unauthorizedHandler?.();
    throw new ApiError(401, "登录已失效，请重新登录");
  }
  if (!resp.ok) {
    // 契约 §5：错误体 {"detail": ...}，透传 message
    let detail = `请求失败（HTTP ${resp.status}）`;
    try {
      const data: unknown = await resp.json();
      if (
        data &&
        typeof data === "object" &&
        "detail" in data &&
        typeof (data as { detail: unknown }).detail === "string"
      ) {
        detail = (data as { detail: string }).detail;
      }
    } catch {
      // 保持默认 message
    }
    throw new ApiError(resp.status, detail);
  }

  const text = await resp.text();
  if (!text) return undefined as T;
  // uid 是 bigint（可 > 2^53，如 233830818118639616）：JSON.parse 浮点解析会
  // 丢精度。解析前把 ≥16 位的 uid/ownerUid 数字字面量保留为字符串（仅展示/URL 用）。
  return JSON.parse(text.replace(/("(?:uid|ownerUid)"\s*:\s*)(\d{16,})/g, '$1"$2"')) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    sp.set(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// —— 契约 §5 端点封装（组件禁止直接 fetch） ——

export const api = {
  login: (username: string, password: string) =>
    post<LoginResult>("/api/login", { username, password }),
  logout: () => post<void>("/api/logout"),
  me: () => request<MeInfo>("/api/me"),
  changePassword: (oldPassword: string, newPassword: string) =>
    post<void>("/api/me/password", { oldPassword, newPassword }),

  users: (params: {
    q?: string;
    /** 前端按正则判定的查询方式；后端会再次校验（缺省时后端自行推断） */
    mode?: UserQueryMode;
    page?: number;
    pageSize?: number;
  }) => request<Paged<UserItem> & { queryMode?: UserQueryMode }>(`/api/users${qs(params)}`),
  userDetail: (uid: number | string) => request<UserDetail>(`/api/users/${uid}`),

  shares: (params: {
    status?: string;
    uid?: number | string;
    revoked?: boolean;
    /** true = 仅目标仍存在的可审核分享；false = 仅目标已删除的存量记录 */
    available?: boolean;
    q?: string;
    page?: number;
    pageSize?: number;
  }) => {
    // 后端要求 revoked / available 为 0/1（"true"/"false" 会 400）
    const { revoked, available, ...rest } = params;
    const bit = (v: boolean | undefined) => (v === undefined ? undefined : v ? 1 : 0);
    return request<Paged<ShareItem>>(
      `/api/shares${qs({ ...rest, revoked: bit(revoked), available: bit(available) })}`,
    );
  },
  shareDetail: (id: number) => request<ShareDetail>(`/api/shares/${id}`),
  /** admin 专用：受控预览分享内文件（短时效内联 URL；每次查看后端留审计） */
  previewShareFile: (shareId: number, fileId: number) =>
    request<PreviewGrant>(`/api/shares/${shareId}/files/${fileId}/preview`),
  banShare: (id: number, reason: string) =>
    post<void>(`/api/shares/${id}/ban`, { reason }),
  unbanShare: (id: number, reason?: string) =>
    post<void>(`/api/shares/${id}/unban`, { reason: reason || undefined }),
  approveShare: (id: number, reason?: string) =>
    post<void>(`/api/shares/${id}/approve`, { reason: reason || undefined }),

  audit: (params: { action?: string; admin?: string; page?: number; pageSize?: number }) =>
    request<Paged<AuditItem>>(`/api/audit${qs(params)}`),
};

