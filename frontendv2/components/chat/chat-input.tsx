"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { ArrowUp, Square, X, FileUp, ImagePlus, Paperclip } from "lucide-react";
import { SlashMenu, buildSlashItems } from "./slash-menu";
import { ChatModelPicker, type ChatModelSelection } from "./chat-model-picker";
import type { ReasoningEffort } from "./effort-slider";
import { ChatAttachmentsDrawer } from "./chat-attachments-drawer";
import { StreamElapsed } from "./streaming-elapsed";
import {
  skillsApi,
  type ChatModel,
  type InstalledSkill,
  type SessionDocument,
} from "@/lib/api";

export interface SelectedSkill {
  skill_id: string;
  name: string;
}

interface ChatInputProps {
  onSend: (message: string, skillIds?: string[], images?: string[]) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  // Wall-clock start of the live turn (Date.now() at send) for the small
  // "生成中 · Ns" hint beside the stop button; ignored when not streaming.
  streamStartedAt?: number;
  onStop?: () => void;
  placeholder?: string;
  hideDisclaimer?: boolean;
  // Slash-menu wiring (skills forced-injection + quiz wizard)
  selectedSkills?: SelectedSkill[];
  onToggleSkill?: (skill: SelectedSkill) => void;
  onOpenQuizWizard?: () => void;
  // 会话文档上传（pdf/docx/pptx/txt/md/html）— 由视图上传到 /chat/documents
  onAttachDocuments?: (files: File[]) => void;
  // 当前会话已上传的文档 + 删除入口：统一在「附件」抽屉里展示（不再常驻 chips）
  sessionFiles?: SessionDocument[];
  onDeleteSessionFile?: (doc: SessionDocument) => void;
  // 待发送图片点击预览（复用视图的图片灯箱）
  onPreviewImage?: (src: string) => void;
  // 聊天模型选择：系统目录模型 / 默认模型 / Coding Plan 模型三选一
  models?: ChatModel[];
  selectedModel?: string;
  codingPlanModel?: string;
  onModelChange?: (selection: ChatModelSelection) => void;
  /** 推理强度（min/mid/high/max）：模型弹层底部的滑动变阻器 */
  reasoningEffort?: ReasoningEffort;
  onReasoningEffortChange?: (value: ReasoningEffort) => void;
  // 生成中已排队、等待本轮结束后自动发送的消息数量（仅用于提示文案）
  queuedCount?: number;
}

// Apple-style chat input - a single rounded card that grows with content up to
// a responsive cap, then scrolls internally. Send button is a filled accent
// circle. Typing "/" as the first character opens the slash menu.
// MIN_HEIGHT = one 24px line (leading-6) + py-1 (4px x 2) = 32px, which equals
// the send button's h-8: with the flex items-end row, a single-line input is
// then exactly as tall as the button, so the text sits vertically centered in
// the card (previously a 24px textarea bottom-aligned against a 32px button
// left ~4px more space above the text than below -> text looked shifted down).
// The composer stays one line until the draft exceeds EXPAND_AFTER_CHARS (or
// contains a newline); only then does it grow, up to a viewport-bounded ceiling.
// Past the ceiling it scrolls internally with a thin scrollbar instead of
// pushing the message list away.
const MIN_HEIGHT = 32;
const EXPAND_AFTER_CHARS = 72;
const MAX_HEIGHT = 160;
const MAX_HEIGHT_RATIO = 0.25;
const MIN_MAX_HEIGHT = 96;
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
  streamStartedAt,
  onStop,
  placeholder = "问我任何关于你收藏的视频…",
  hideDisclaimer = false,
  selectedSkills = [],
  onToggleSkill,
  onOpenQuizWizard,
  onAttachDocuments,
  sessionFiles = [],
  onDeleteSessionFile,
  onPreviewImage,
  models = [],
  selectedModel = "",
  codingPlanModel,
  onModelChange,
  reasoningEffort = "mid",
  onReasoningEffortChange,
  queuedCount = 0,
}: ChatInputProps) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [imageError, setImageError] = useState("");
  // 附件抽屉：待发送图片 + 会话文件（输入框上方不再常驻缩略图/chips）
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const [skills, setSkills] = useState<InstalledSkill[] | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 附件菜单：点击外部 / Esc 关闭（图片、文档、查看附件统一收在一个入口）。
  useEffect(() => {
    if (!attachMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) {
        setAttachMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAttachMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [attachMenuOpen]);

  // Responsive composer ceiling (desktop 320px; smaller windows/keyboards get
  // proportionally less so the message list keeps usable space).
  const [maxHeight, setMaxHeight] = useState(MAX_HEIGHT);
  useEffect(() => {
    const compute = () =>
      setMaxHeight(
        Math.max(
          MIN_MAX_HEIGHT,
          Math.min(MAX_HEIGHT, Math.round(window.innerHeight * MAX_HEIGHT_RATIO)),
        ),
      );
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);

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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clamp the cursor when the filtered slash list shrinks; one derived reset, no cascading renders
    if (activeIndex >= items.length) setActiveIndex(0);
  }, [items.length, activeIndex]);

  // Reset dismissal whenever the raw input changes, so "/" reopens the menu.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derived reset on user input (single extra render); no external system involved
    setMenuDismissed(false);
  }, [input]);

  // Threshold-based growth: one-line drafts keep the compact height (no
  // per-keystroke reflow); past the threshold the composer grows up to the cap,
  // then scrolls internally with the thin textarea scrollbar.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const full = el.scrollHeight;
    // Grow only once the draft needs a second line (or passes the char
    // threshold) — never clip wrapped text, and never reflow on every keystroke
    // while it still fits.
    const shouldExpand = input.includes("\n") || input.length > EXPAND_AFTER_CHARS || full > MIN_HEIGHT;
    if (!shouldExpand) {
      el.style.height = `${MIN_HEIGHT}px`;
      el.style.overflowY = "hidden";
      return;
    }
    const next = Math.max(MIN_HEIGHT, Math.min(full, maxHeight));
    el.style.height = `${next}px`;
    el.style.overflowY = full > maxHeight ? "auto" : "hidden";
  }, [input, maxHeight]);

  const canSend = (input.trim().length > 0 || images.length > 0) && !disabled;
  const attachmentCount = images.length + sessionFiles.length;

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

      {imageError && (
        <div className="mb-1.5 text-[12px] text-danger" role="alert">
          {imageError}
        </div>
      )}

      <div
        className={`rounded-[24px] border bg-white px-3 pb-1.5 pt-2.5 shadow-[0_2px_6px_rgba(0,0,0,0.04)] transition-colors sm:rounded-[26px] ${
          canSend ? "border-[#e5e5e5]" : "border-[#ececec]"
        } ${isStreaming ? "border-[#d9d9d9]" : ""}`}
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

        {/* Row 1: the input owns the full card width. */}
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
          className="block w-full resize-none bg-transparent px-1 py-1 text-[16px] leading-6 text-[#0d0d0d] placeholder:text-[#8f8f8f] focus:outline-none disabled:opacity-50 [scrollbar-width:thin]"
          style={{ minHeight: `${MIN_HEIGHT}px`, maxHeight: `${maxHeight}px` }}
          aria-label="聊天消息输入"
          aria-disabled={disabled}
        />

        {/* Row 2: one attachment entry on the left, model picker + send/stop on the right. */}
        <div className="mt-1 flex items-center justify-between gap-1.5 sm:gap-2">
          <div ref={attachMenuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => {
                // 同时只保留一个浮层：打开附件菜单时收起斜杠命令菜单。
                setMenuDismissed(true);
                setAttachMenuOpen((open) => !open);
              }}
              className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors hover:bg-border-subtle sm:h-8 sm:w-8 ${
                attachmentCount > 0 ? "text-accent" : "text-tertiary hover:text-foreground"
              }`}
              aria-label={`添加或查看附件（${attachmentCount}）`}
              aria-haspopup="menu"
              aria-expanded={attachMenuOpen}
              title="添加附件（图片 / 文档）或查看已上传文件"
            >
              <Paperclip className="h-[18px] w-[18px] sm:h-4 sm:w-4" aria-hidden="true" />
              {attachmentCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-accent px-1 text-[9px] font-medium leading-none text-white">
                  {attachmentCount}
                </span>
              )}
            </button>

            {attachMenuOpen && (
              <div
                role="menu"
                aria-label="附件操作"
                className="absolute bottom-full left-0 z-50 mb-2 w-60 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-[0_10px_30px_rgba(0,0,0,0.14)]"
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={disabled || isStreaming}
                  onClick={() => {
                    setAttachMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-foreground transition-colors hover:bg-border-subtle/50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ImagePlus className="h-4 w-4 shrink-0 text-tertiary" aria-hidden="true" />
                  <span className="min-w-0 flex-1">上传图片</span>
                  <span className="shrink-0 text-[10px] text-tertiary">≤4 张</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={disabled || isStreaming}
                  onClick={() => {
                    setAttachMenuOpen(false);
                    docInputRef.current?.click();
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-foreground transition-colors hover:bg-border-subtle/50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <FileUp className="h-4 w-4 shrink-0 text-tertiary" aria-hidden="true" />
                  <span className="min-w-0 flex-1">上传文档</span>
                  <span className="shrink-0 text-[10px] text-tertiary">pdf/docx…</span>
                </button>
                <div className="mx-2 my-1 h-px bg-border-subtle" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAttachMenuOpen(false);
                    setAttachmentsOpen(true);
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-foreground transition-colors hover:bg-border-subtle/50"
                >
                  <Paperclip className="h-4 w-4 shrink-0 text-tertiary" aria-hidden="true" />
                  <span className="min-w-0 flex-1">查看附件</span>
                  <span className="shrink-0 rounded-full bg-border-subtle px-1.5 py-0.5 text-[10px] tabular-nums text-secondary">
                    {attachmentCount}
                  </span>
                </button>
              </div>
            )}
          </div>

          <div className="flex min-w-0 items-center justify-end gap-1.5">
            {/* 流式中的轻量计时提示：stop 按钮旁，窄屏隐藏以免输入行溢出 */}
            {isStreaming && (
              <span
                className="hidden shrink-0 items-center text-[11px] leading-none text-tertiary sm:inline-flex"
                aria-hidden="true"
              >
                生成中
                <StreamElapsed key={streamStartedAt ?? "live"} startedAt={streamStartedAt} />
              </span>
            )}

            {onModelChange && (
              <ChatModelPicker
                models={models}
                value={selectedModel}
                codingPlanValue={codingPlanModel}
                reasoningEffort={reasoningEffort}
                onReasoningEffortChange={onReasoningEffortChange}
                onChange={onModelChange}
                disabled={disabled}
              />
            )}

            {isStreaming ? (
              <span className="flex shrink-0 items-center gap-1">
                {/* 生成中按 Enter（或点这个按钮）→ 排队，本轮结束后自动发送 */}
                {canSend && (
                  <button
                    type="button"
                    onClick={handleSend}
                    className="grid h-9 w-9 place-items-center rounded-full bg-[#0d0d0d] text-white transition-all hover:bg-[#2f2f2f] sm:h-8 sm:w-8"
                    aria-label="排队发送（本轮结束后自动发送）"
                    title="排队发送：本轮生成结束后自动发送"
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={onStop}
                  className="grid h-9 w-9 place-items-center rounded-full bg-[#0d0d0d] text-white transition-opacity hover:opacity-80 sm:h-8 sm:w-8"
                  aria-label="停止生成"
                >
                  <Square className="h-3 w-3 fill-current" aria-hidden="true" />
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#0d0d0d] text-white transition-all hover:bg-[#2f2f2f] disabled:cursor-not-allowed disabled:bg-[#e5e5e5] disabled:text-[#b4b4b4] sm:h-8 sm:w-8"
                aria-label="发送消息"
              >
                <ArrowUp className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>

      {isStreaming && (
        <div className="mt-1.5 text-center text-[11px] text-tertiary" aria-live="polite">
          生成中 · <kbd className="font-sans">⏎</kbd> 将排队发送
          {queuedCount > 0 ? `（已排队 ${queuedCount} 条）` : ""}
          ，本轮结束后自动发送
        </div>
      )}
      {!hideDisclaimer && (
        <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-2 text-center text-[11px] text-tertiary" aria-live="polite">
          <span>
            <kbd className="font-sans">⏎</kbd> 发送 · <kbd className="font-sans">⇧ ⏎</kbd> 换行
          </span>
          <span className="text-border">·</span>
          <span>输入 / 使用命令与技能 · AI 可能出错，重要信息请核实</span>
        </div>
      )}

      <ChatAttachmentsDrawer
        open={attachmentsOpen}
        onClose={() => setAttachmentsOpen(false)}
        images={images}
        onRemoveImage={(index) => setImages((prev) => prev.filter((_, i) => i !== index))}
        sessionFiles={sessionFiles}
        onDeleteSessionFile={onDeleteSessionFile}
        onPreviewImage={onPreviewImage}
      />
    </div>
  );
}
