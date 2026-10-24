// 契约 §5：app-admin API 类型定义（frontend-admin 内唯一数据形状来源）

export type AdminRole = "admin" | "viewer";

// 注意：uid 为 bigint（如 233830818118639616 > 2^53）。client.ts 会在 JSON.parse
// 前把 ≥16 位的 uid/ownerUid 数字字面量保留为字符串，故该字段运行时可能为
// string —— 仅用于展示与 URL 拼接，勿做数值运算。契约侧建议后端序列化为
// string（已报 Lead 转 admin-back）。
export type Uid = number | string;

/** GET /api/login、GET /api/me 共同 shape */
export interface MeInfo {
  username: string;
  role: AdminRole;
  mustChangePassword: boolean;
}

export type ModerationStatus = "active" | "approved" | "banned" | "";

/** POST /api/login 响应（登录成功即作为会话态写入 store） */
export interface LoginResult {
  username: string;
  role: AdminRole;
  mustChangePassword: boolean;
}

/** GET /api/users 的精确查询方式：UID / 11 位手机号 / 邮箱。 */
export type UserQueryMode = "uid" | "phone" | "email";

export interface UserItem {
  uid: Uid;
  email: string | null;
  phone: string | null;
  nickname: string | null;
  status: string;
  /** active rbac 绑定（列表用 string[]） */
  roles: string[];
  createdAt: string | null;
}

/** 单用户角色明细（GET /api/users/:uid 实测 shape：{roleId,name,granted,isActive}；expires 后端未返回） */
export interface RoleGrant {
  roleId: string;
  name: string;
  granted: string | null;
  expires?: string | null;
  isActive: boolean;
}

export interface UserDetail extends Omit<UserItem, "roles"> {
  /** 详情 roles = 角色明细对象数组；列表 items.roles 为展示名 string[]（实测一致） */
  roles: RoleGrant[];
}

export interface ShareItem {
  id: number;
  targetType: "file" | "folder";
  /** 文件名或共享文件夹名 */
  name: string;
  ownerUid: Uid;
  ownerNickname: string | null;
  fileCount: number;
  totalSize: number;
  hasCode: boolean;
  expiresAt: string | null;
  viewCount: number;
  downloadCount: number;
  isRevoked: boolean;
  /** 分享目标（文件/文件夹）是否仍存在；false = 目标已删除，无可审核内容 */
  contentAvailable: boolean;
  /** 用户创建分享时对"管理员可依法查看分享内容"的单独确认 */
  contentReviewAck: boolean;
  moderationStatus: ModerationStatus;
  moderationReason: string | null;
  moderationTime: string | null;
  moderationBy: string | null;
  createdAt: string | null;
}

/** 文件元数据（含 fileId：admin 受控预览的句柄；无内容/下载能力） */
export interface ShareFileMeta {
  fileId: number;
  name: string;
  size: number;
  mimeType: string;
  path: string;
}

/** GET /api/shares/:id/files/:fileId/preview —— 受控内容预览授权（无下载） */
export interface PreviewGrant {
  url: string;
  viewMode: "pdf" | "video" | "audio" | "image" | "html" | "markdown" | "text" | "unsupported";
  mimeType: string;
  fileName: string;
  fileSize: number;
  expiresIn: number;
  text?: string;
  truncated?: boolean;
}

export interface ShareDetail extends ShareItem {
  files: ShareFileMeta[];
  /** 文件夹分享超过 2000 个文件时后端截断并置 true */
  truncated?: boolean;
}

/** GET /api/audit（实测响应为 camelCase：admin/targetType/targetId/createdAt —— 已对齐） */
export interface AuditItem {
  id: number;
  admin: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: string | null;
  createdAt: string | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
}
