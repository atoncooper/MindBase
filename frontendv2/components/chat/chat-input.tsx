"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { ArrowUp, Square, X, ImagePlus, Paperclip } from "lucide-react";
import { SlashMenu, buildSlashItems } from "./slash-menu";
import { skillsApi, type InstalledSkill } from "@/lib/api";

export interface SelectedSkill {
  skill_id: string;
  name: string;
}

interface ChatInputProps {
  onSend: (message: string, skillIds?: string[], images?: string[]) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  onStop?: () => void;
  placeholder?: string;
  hideDisclaimer?: boolean;
  // Slash-menu wiring (skills forced-injection + quiz wizard)
  selectedSkills?: SelectedSkill[];
  onToggleSkill?: (skill: SelectedSkill) => void;
  onOpenQuizWizard?: () => void;
  // 会话文档上传（pdf/docx/pptx/txt/md/html）— 由视图上传到 /chat/documents
  onAttachDocuments?: (files: File[]) => void;
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

// ---- 图片压缩:大截图先缩放再附加,不再粗暴拒绝 ----
// 等比缩到最长边 2000px;优先 PNG(UI 截图文字锐利、压缩率高),超限自动转
// JPEG 逐档降质;满足后端单张 data URL 上限(app-ts 2M chars)留有余量。
// ≤1.1MB 的原图原样直传(GIF 动图不重编码,避免丢帧)。
const IMAGE_PASSTHROUGH_BYTES = 1_100_000;
const IMAGE_MAX_SIDE = 2000;
const IMAGE_DATA_URL_LIMIT = 1_800_000;

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("empty read"));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

async function compressImageFile(file: File): Promise<string> {
  if (file.size <= IMAGE_PASSTHROUGH_BYTES) return readAsDataUrl(file);
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return readAsDataUrl(file); // 极端环境兜底:原样直传(超限会由后端明确报错)
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (png) {
    const url = await readAsDataUrl(png);
    if (url.length <= IMAGE_DATA_URL_LIMIT) return url;
  }
  for (const q of [0.9, 0.8, 0.7, 0.6]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
    if (!blob) continue;
    const url = await readAsDataUrl(blob);
    if (url.length <= IMAGE_DATA_URL_LIMIT) return url;
  }
  throw new Error("compress-failed");
}

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
  onAttachDocuments,
}: ChatInputProps) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [imageError, setImageError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
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

  const canSend = (input.trim().length > 0 || images.length > 0) && !disabled;

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

  // 多模态：选择/粘贴图片 → 压缩后附为 data URL（≤4 张；大图自动缩放/转码，不再拒绝）
  const addImages = useCallback(
    (files: ArrayLike<File>) => {
      setImageError("");
      const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (list.length === 0) return;
      void (async () => {
        const next: string[] = [];
        let overflow = false;
        for (const file of list) {
          if (images.length + next.length >= 4) {
            overflow = true;
            break;
          }
          try {
            next.push(await compressImageFile(file));
          } catch {
            setImageError(`图片 ${file.name} 处理失败，请截取后重试`);
          }
        }
        if (overflow) setImageError("图片数量超限（最多 4 张）");
        if (next.length > 0) setImages((prev) => [...prev, ...next].slice(0, 4));
      })();
    },
    [images]
  );

  // 会话文档：按扩展名过滤（与后端 doc-parser 支持面一致），交给视图上传
  const DOC_EXTENSIONS = ["pdf", "docx", "pptx", "txt", "md", "markdown", "html", "htm"];
  const addDocuments = (files: ArrayLike<File>) => {
    if (!onAttachDocuments) return;
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(files)) {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (DOC_EXTENSIONS.includes(ext)) accepted.push(file);
      else rejected.push(file.name);
    }
    if (rejected.length > 0) {
      setImageError(`不支持的文档类型：${rejected.join("、")}（支持 pdf/docx/pptx/txt/md/html）`);
    } else {
      setImageError("");
    }
    if (accepted.length > 0) onAttachDocuments(accepted);
  };

  const handleSend = () => {
    const trimmed = input.trim();
    if ((!trimmed && images.length === 0) || disabled) return;
    const skillIds = selectedSkills.map((s) => s.skill_id);
    onSend(trimmed, skillIds.length > 0 ? skillIds : undefined, images.length > 0 ? images : undefined);
    setInput("");
    setImages([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
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

      {images.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-2">
          {images.map((src, i) => (
            <div key={i} className="relative">
              <img src={src} alt={`附件 ${i + 1}`} className="h-16 w-16 rounded-lg border border-border object-cover" />
              <button
                type="button"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-border bg-surface text-tertiary transition-colors hover:text-foreground"
                aria-label={`移除图片 ${i + 1}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {imageError && (
        <div className="mb-1.5 text-[12px] text-danger" role="alert">
          {imageError}
        </div>
      )}

      <div
        className={`flex items-end gap-2 rounded-[22px] border bg-surface px-3 py-2 shadow-[0_2px_12px_rgba(0,0,0,0.04)] transition-colors ${
          canSend ? "border-border" : "border-border-subtle"
        } ${isStreaming ? "border-accent/40" : ""}`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addImages(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={docInputRef}
          type="file"
          accept=".pdf,.docx,.pptx,.txt,.md,.markdown,.html,.htm"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addDocuments(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => docInputRef.current?.click()}
          disabled={disabled || isStreaming}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-50"
          aria-label="上传文档到当前会话"
          title="上传文档到当前会话（pdf/docx/pptx/txt/md/html）"
        >
          <Paperclip className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || isStreaming}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-50"
          aria-label="添加图片"
        >
          <ImagePlus className="h-4 w-4" />
        </button>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files ?? []);
            if (files.length > 0) {
              e.preventDefault();
              addImages(files);
            }
          }}
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
