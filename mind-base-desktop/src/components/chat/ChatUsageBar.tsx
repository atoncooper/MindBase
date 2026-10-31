/**
 * 输入框下方的会话用量条（Gemini / DeepSeek-Harness 风格）：
 * 轮次 · 步数 · 会话累计 token · 缓存命中率，居中、弱化，不抢正文注意力。
 */
import { useMemo } from "react";

import type { TokenUsage } from "../../lib/chat";
import type { UiMessage } from "./MessageList";

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  const scaled = value / 1000;
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)}k`;
}

interface Props {
  messages: UiMessage[];
  busy: boolean;
}

export default function ChatUsageBar({ messages, busy }: Props): React.JSX.Element | null {
  const stats = useMemo(() => {
    let turns = 0;
    let steps = 0;
    let input = 0;
    let output = 0;
    let cached = 0;
    let total = 0;
    for (const message of messages) {
      if (message.role === "user") turns += 1;
      steps += message.steps.length;
      const usage: TokenUsage | null | undefined = message.usage;
      if (usage === null || usage === undefined) continue;
      const itemInput = usage.inputTokens ?? 0;
      const itemOutput = usage.outputTokens ?? 0;
      input += itemInput;
      output += itemOutput;
      cached += usage.cachedTokens ?? 0;
      total += usage.totalTokens ?? itemInput + itemOutput;
    }
    return { turns, steps, input, output, cached, total };
  }, [messages]);

  if (stats.turns === 0 && !busy) return null;

  const parts: string[] = [`${stats.turns} 轮`];
  if (stats.steps > 0) parts.push(`${stats.steps} 步`);
  if (stats.total > 0) {
    parts.push(`会话 ${formatTokenCount(stats.total)} tok`);
    if (stats.cached > 0) {
      const rate = stats.input > 0 ? Math.round((stats.cached / stats.input) * 100) : 0;
      parts.push(`缓存命中 ${rate}%`);
    }
  } else if (busy) {
    parts.push("生成中…");
  }

  return (
    <div
      className="chat-usage"
      aria-live="polite"
      title={
        stats.total > 0
          ? `会话累计 token：输入 ${stats.input} · 输出 ${stats.output} · 缓存命中 ${stats.cached}`
          : "尚未产生 token 用量"
      }
    >
      {parts.join(" · ")}
    </div>
  );
}
