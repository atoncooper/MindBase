// 控制台账户管理（admin；不再依赖支付库，pay 关闭也可用）
// 组件禁止直接 fetch：统一经 client.ts 的 request/post。
import { post, request } from "./client";
import type { AdminRole } from "./types";

/** GET /api/console/users 的列表项 */
export interface ConsoleUserItem {
  id: number;
  username: string;
  role: AdminRole;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string | null;
}

/** POST /api/console/users 的响应 */
export interface ConsoleUserCreateResult {
  id: number;
  username: string;
  role: AdminRole;
}

export interface ConsoleUserCreateBody {
  /** 2..64 */
  username: string;
  /** 8..128 */
  password: string;
  /** 缺省 viewer */
  role?: AdminRole;
}

export const accountsApi = {
  /** 列表（username ASC，后端不分页） */
  list: () => request<{ items: ConsoleUserItem[] }>("/api/console/users"),

  /** 新建账户（409 = 用户名已存在） */
  create: (body: ConsoleUserCreateBody) =>
    post<ConsoleUserCreateResult>("/api/console/users", body),

  /** 重置密码：后端置 must_change_password=true 并删除该账户所有会话 */
  resetPassword: (id: number, password: string) =>
    post<{ ok: boolean }>(`/api/console/users/${id}/password`, { password }),

  /** 删除账户：后端拦截删除自己 / 最后一个 admin（400），并删除其会话 */
  remove: (id: number) =>
    request<{ ok: boolean }>(`/api/console/users/${id}`, { method: "DELETE" }),
};
