import { config } from "../config/index.js";

/**
 * 降级阶梯（L1 省流）的进程内状态与取值口径，集中在此避免口径散落：
 *  - noteTurnLevel：聊天轮准入时登记该 uid 本轮级别（TTL 防泄漏，容量有界）；
 *  - currentTurnLevel：工具层 / 主循环读取（非聊天轮恒为 L0）；
 *  - searchKFor / historyLimitFor / maxOutputTokensFor：L1 的三个杠杆——
 *    检索条数减半、历史窗口减半、输出预算封顶（provider 无关，思考 token
 *    计入输出因此被一并截断）。思考开关的网关透传待验证，暂不启用。
 */

export type DegradeLevel = "L0" | "L1";

const turnLevels = new Map<string, { level: DegradeLevel; expiresAt: number }>();
const TURN_LEVEL_TTL_MS = 10 * 60_000;
const MAX_TRACKED = 100_000;

/** 登记当前轮的降级级别（uid 缺失 = 匿名轮，不登记）。 */
export function noteTurnLevel(uid: string | undefined, level: DegradeLevel): void {
  if (!uid) return;
  turnLevels.set(uid, { level, expiresAt: Date.now() + TURN_LEVEL_TTL_MS });
  if (turnLevels.size > MAX_TRACKED) {
    const now = Date.now();
    for (const [key, entry] of turnLevels) {
      if (entry.expiresAt <= now) turnLevels.delete(key);
    }
  }
}

/** 当前登记中的 uid 数（/agent/runtime 观测用）。 */
export function trackedTurns(): number {
  return turnLevels.size;
}

/** 读取当前轮级别：无登记 / 已过期 / 非聊天轮 → L0（全量）。 */
export function currentTurnLevel(uid: string | undefined): DegradeLevel {
  if (!uid) return "L0";
  const hit = turnLevels.get(uid);
  if (!hit || hit.expiresAt <= Date.now()) return "L0";
  return hit.level;
}

/** L1：检索条数减半（下限 3，保证回答仍有依据）。 */
export function searchKFor(uid: string | undefined, baseK: number): number {
  return currentTurnLevel(uid) === "L1" ? Math.max(3, Math.round(baseK / 2)) : baseK;
}

/** L1：对话历史窗口减半（下限 2 条）。 */
export function historyLimitFor(baseKeep: number, level: DegradeLevel): number {
  return level === "L1" ? Math.max(2, Math.round(baseKeep / 2)) : baseKeep;
}

/** L1：单轮输出 token 预算（0 = 不设限）。 */
export function maxOutputTokensFor(uid: string | undefined): number {
  return currentTurnLevel(uid) === "L1" ? config.quota.l1MaxOutputTokens : 0;
}
