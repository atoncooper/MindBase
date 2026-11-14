"use client";

/**
 * QueuedMessages — messages typed while the current turn is still streaming.
 *
 * They are NOT part of the transcript yet: the chat view holds them in memory
 * and sends them FIFO as soon as the active turn settles (done / error / stop).
 * Each row can be cancelled before it is sent.
 */
import { Clock3, X } from "lucide-react";

export interface QueuedMessage {
  id: string;
  text: string;
  skillIds?: string[];
  images?: string[];
}

export function QueuedMessages({
  items,
  onCancel,
}: {
  items: QueuedMessage[];
  onCancel: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div
      className="mb-2 rounded-xl border border-border-subtle bg-border-subtle/40 px-3 py-2"
      role="region"
      aria-label="待发送消息队列"
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-secondary">
        <Clock3 className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>待发送 · 本轮生成结束后自动发送（{items.length}）</span>
      </div>
      <div className="flex flex-col gap-1">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
              {item.text}
            </span>
            {item.images && item.images.length > 0 && (
              <span className="shrink-0 text-[11px] text-tertiary">+{item.images.length} 图</span>
            )}
            <button
              type="button"
              onClick={() => onCancel(item.id)}
              className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
              aria-label="取消这条排队消息"
              title="取消这条排队消息"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
