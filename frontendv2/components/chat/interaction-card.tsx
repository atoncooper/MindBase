"use client";

/**
 * InteractionCard - AI→用户结构化交互卡（ask_user 工具 → `interact` SSE 帧）。
 *
 * 三种形态（与 app-ts InteractionPayload 对齐）：
 *   clarify —— 澄清提问，渲染可点击选项 chips，点击即把规范化答案作为下一条消息发送；
 *   confirm —— 写操作前确认卡片，默认「确认执行 / 取消」两个按钮；
 *   form    —— 多字段表单一次收集，提交时把「字段label：值」逐行拼成规范化答案。
 *
 * 回答即发送（round-based，无恢复协议）：answered 后卡片进入只读 settled 态。
 */

import { useState } from "react";
import { CircleHelp, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatInteraction } from "@/lib/chat-stream";

const KIND_LABEL: Record<ChatInteraction["kind"], string> = {
  clarify: "需要澄清",
  confirm: "操作确认",
  form: "补充信息",
};

const FIELD_TYPE: Record<string, string> = {
  text: "text",
  email: "email",
  datetime: "datetime-local",
  select: "select",
};

export function InteractionCard({
  interaction,
  answered,
  disabled,
  onAnswer,
}: {
  interaction: ChatInteraction;
  answered: boolean;
  disabled?: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const isForm = interaction.kind === "form";
  const chips = isForm ? [] : interaction.options ?? [];
  const fields = isForm ? interaction.fields ?? [] : [];
  const locked = answered || disabled;

  const submitForm = () => {
    const missing = fields.filter((f) => f.required && !values[f.name]?.trim());
    if (missing.length > 0) {
      setFormError(`请填写：${missing.map((f) => f.label).join("、")}`);
      return;
    }
    const lines = fields
      .filter((f) => values[f.name]?.trim())
      .map((f) => `${f.label}：${values[f.name]!.trim()}`);
    if (lines.length === 0) {
      setFormError("请至少填写一项");
      return;
    }
    setFormError(null);
    onAnswer(lines.join("\n"));
  };

  return (
    <div
      className={cn(
        "mt-3 rounded-xl border border-amber-300/60 bg-amber-50/50 p-4",
        answered && "opacity-60"
      )}
      role="group"
      aria-label={KIND_LABEL[interaction.kind]}
    >
      <div className="flex items-center gap-2">
        <CircleHelp className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
        <span className="text-[12px] font-medium text-amber-700">
          {KIND_LABEL[interaction.kind]}
        </span>
        {answered && (
          <span className="ml-auto text-[11px] text-tertiary">回答已发送</span>
        )}
      </div>

      <p className="mt-2 text-[14px] font-medium leading-relaxed text-foreground">
        {interaction.question}
      </p>
      {interaction.context && (
        <p className="mt-1 text-[12px] leading-relaxed text-secondary">{interaction.context}</p>
      )}

      {/* clarify / confirm：选项 chips，点击即回答 */}
      {chips.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={locked}
              onClick={() => onAnswer(option.value)}
              className={cn(
                "rounded-full border border-amber-300 bg-white px-3.5 py-1.5 text-[13px] font-medium text-foreground transition-colors",
                locked
                  ? "cursor-default opacity-70"
                  : "hover:border-amber-400 hover:bg-amber-100/70"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      {/* form：多字段一次收集 */}
      {fields.length > 0 && (
        <div className="mt-3 space-y-2.5">
          {fields.map((field) => (
            <label key={field.name} className="block">
              <span className="mb-1 flex items-center gap-1 text-[12px] font-medium text-secondary">
                {field.label}
                {field.required && <span className="text-danger">*</span>}
              </span>
              {FIELD_TYPE[field.type ?? "text"] === "select" ? (
                <select
                  value={values[field.name] ?? ""}
                  disabled={locked}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                  }
                  className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[13px] text-foreground focus:border-accent focus:outline-none disabled:opacity-70"
                >
                  <option value="">请选择…</option>
                  {(field.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={FIELD_TYPE[field.type ?? "text"]}
                  value={values[field.name] ?? ""}
                  disabled={locked}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                  }
                  className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[13px] text-foreground focus:border-accent focus:outline-none disabled:opacity-70"
                />
              )}
            </label>
          ))}
          {formError && <p className="text-[12px] text-danger">{formError}</p>}
          {!answered && (
            <button
              type="button"
              disabled={locked}
              onClick={submitForm}
              className="btn-pill inline-flex h-8 items-center gap-1.5 bg-[#1f2329] px-4 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              <Send className="h-3 w-3" aria-hidden="true" />
              提交
            </button>
          )}
        </div>
      )}
    </div>
  );
}
