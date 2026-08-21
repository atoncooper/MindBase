"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { ArrowUp, Square, X } from "lucide-react";
import { SlashMenu, buildSlashItems } from "./slash-menu";
import { skillsApi, type InstalledSkill } from "@/lib/api";

export interface SelectedSkill {
  skill_id: string;
  name: string;
}

interface ChatInputProps {
  onSend: (message: string, skillIds?: string[]) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  onStop?: () => void;
  placeholder?: string;
  hideDisclaimer?: boolean;
  // Slash-menu wiring (skills forced-injection + quiz wizard)
  selectedSkills?: SelectedSkill[];
  onToggleSkill?: (skill: SelectedSkill) => void;
  onOpenQuizWizard?: () => void;
}

// Apple-style chat input - a single rounded card that grows with content up to
// MAX_HEIGHT, then scrolls internally. Send button is a filled accent circle.
// Typing "/" as the first character opens the slash menu (commands + skills).
// MIN_HEIGHT = one 24px line (leading-6) + py-1 (4px x 2) = 32px, which equals
// the send button's h-8: with the flex items-end row, a single-line input is
// then exactly as tall as the button, so the text sits vertically centered in
// the card (previously a 24px textarea bottom-aligned against a 32px button
// left ~4px more space above the text than below -> text looked shifted down).
const MIN_HEIGHT = 32;
const MAX_HEIGHT = 200;
// input starts with "/" followed by no whitespace → slash menu is active
const SLASH_RE = /^\/(\S*)$/;

export function ChatInput({
  onSend,
  disabled = false,
  isStreaming = false,
  onStop,
  placeholder = "问我任何关于你收藏的视频…",
  hideDisclaimer = false,
  selectedSkills = [],
  onToggleSkill,
  onOpenQuizWizard,
}: ChatInputProps) {
  const [input, setInput] = useState("");
  const [skills, setSkills] = useState<InstalledSkill[] | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const slashMatch = input.match(SLASH_RE);
  const slashOpen =
    slashMatch !== null && !menuDismissed && !disabled && !isStreaming;
  const slashFilter = slashMatch ? slashMatch[1] : "";

  const items = useMemo(
    () => buildSlashItems(slashFilter, skills ?? []),
    [slashFilter, skills]
  );

  // Lazy-load installed skills the first time the menu opens.
  useEffect(() => {
    if (!slashOpen || skills !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await skillsApi.listInstalled();
        if (!cancelled) setSkills(list);
      } catch {
        // Menu still works for commands; skills group simply stays empty.
        if (!cancelled) setSkills([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slashOpen, skills]);

  // Keep the keyboard cursor inside the visible item range.
  useEffect(() => {
    if (activeIndex >= items.length) setActiveIndex(0);
  }, [items.length, activeIndex]);

  // Reset dismissal whenever the raw input changes, so "/" reopens the menu.
  useEffect(() => {
    setMenuDismissed(false);
  }, [input]);

  // Auto-resize: reset to auto first so scrollHeight reflects content,
  // then clamp between MIN and MAX. Beyond MAX the textarea scrolls internally.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.max(MIN_HEIGHT, Math.min(el.scrollHeight, MAX_HEIGHT));
    el.style.height = `${next}px`;
  }, [input]);

  const canSend = input.trim().length > 0 && !disabled;

  const handlePickCommand = useCallback(
    (id: string) => {
      if (id === "quiz-from-summary") {
        setInput("");
        onOpenQuizWizard?.();
      }
    },
    [onOpenQuizWizard]
  );

  const pickItem = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      if (item.kind === "command") {
        if (item.commandId) handlePickCommand(item.commandId);
        return;
      }
      // Skills: toggle selection, keep the menu open for multi-select.
      if (item.skill && onToggleSkill) {
        onToggleSkill({ skill_id: item.skill.skill_id, name: item.skill.name });
      }
    },
    [items, handlePickCommand, onToggleSkill]
  );

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    const skillIds = selectedSkills.map((s) => s.skill_id);
    onSend(trimmed, skillIds.length > 0 ? skillIds : undefined);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (slashOpen && items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + items.length) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickItem(activeIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="relative w-full" role="form" aria-label="聊天输入框">
      <SlashMenu
        open={slashOpen}
        filter={slashFilter}
        skills={skills ?? []}
        selectedSkillIds={selectedSkills.map((s) => s.skill_id)}
        activeIndex={activeIndex}
        onActiveIndexChange={setActiveIndex}
        onPickCommand={handlePickCommand}
        onToggleSkill={(s) =>
          onToggleSkill?.({ skill_id: s.skill_id, name: s.name })
        }
      />

      {selectedSkills.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {selectedSkills.map((s) => (
            <span
              key={s.skill_id}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-[12px] text-foreground"
            >
              <span className="truncate">{s.name}</span>
              <button
                type="button"
                onClick={() => onToggleSkill?.(s)}
                className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
                aria-label={`移除技能 ${s.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        className={`flex items-end gap-2 rounded-[22px] border bg-surface px-3 py-2 shadow-[0_2px_12px_rgba(0,0,0,0.04)] transition-colors ${
          canSend ? "border-border" : "border-border-subtle"
        } ${isStreaming ? "border-accent/40" : ""}`}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none bg-transparent py-1 text-[15px] leading-6 text-foreground placeholder:text-tertiary focus:outline-none disabled:opacity-50"
          style={{ minHeight: `${MIN_HEIGHT}px`, maxHeight: `${MAX_HEIGHT}px` }}
          aria-label="聊天消息输入"
          aria-disabled={disabled}
        />

        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-foreground text-background transition-opacity hover:opacity-80"
            aria-label="停止生成"
          >
            <Square className="h-3 w-3 fill-current" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-white transition-all hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-border-subtle disabled:text-tertiary"
            aria-label="发送消息"
          >
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {!hideDisclaimer && (
        <div className="mt-1.5 flex items-center justify-center gap-3 text-[11px] text-tertiary" aria-live="polite">
          <span>
            <kbd className="font-sans">⏎</kbd> 发送 · <kbd className="font-sans">⇧ ⏎</kbd> 换行
          </span>
          <span className="text-border">·</span>
          <span>输入 / 使用命令与技能 · AI 可能出错，重要信息请核实</span>
        </div>
      )}
    </div>
  );
}
