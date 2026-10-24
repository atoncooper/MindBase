// 用户查询方式判定：前端与后端使用同一组规则（后端会再校验一次）。
//   - 含 @ → 邮箱（必须通过邮箱正则）
//   - 1[3-9] 开头的 11 位数字 → 手机号（+86 标准号，不带国家码）
//   - 其他正整数（最多 19 位） → UID
// 空输入 = 不过滤（列出全部用户）。
import type { UserQueryMode } from "../api/types";

export type { UserQueryMode };

export interface UserQueryDetection {
  mode?: UserQueryMode;
  label: string;
  valid: boolean;
  hint: string;
}

const UID_RE = /^[1-9][0-9]{0,18}$/;
const PHONE_RE = /^1[3-9][0-9]{9}$/;
const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

export function detectUserQuery(raw: string): UserQueryDetection {
  const value = raw.trim();
  if (!value) return { valid: true, label: "", hint: "" };
  if (value.includes("@")) {
    return EMAIL_RE.test(value)
      ? { mode: "email", label: "邮箱", valid: true, hint: "" }
      : { mode: "email", label: "邮箱", valid: false, hint: "邮箱格式不合法" };
  }
  if (PHONE_RE.test(value)) {
    return { mode: "phone", label: "手机号", valid: true, hint: "" };
  }
  if (UID_RE.test(value)) {
    return { mode: "uid", label: "UID", valid: true, hint: "" };
  }
  return {
    mode: undefined,
    label: "",
    valid: false,
    hint: "请输入 UID、11 位中国大陆手机号或邮箱",
  };
}
