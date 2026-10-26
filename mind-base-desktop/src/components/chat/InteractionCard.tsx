/**
 * 交互卡片（ask_user 工具触发）：clarify / confirm / form 三种形态。
 *
 * 语义：卡片出现即表示**本轮已结束**（后端落库一句「已向你提问」提示），
 * 用户点选项 / 提交表单 = 作答内容作为**下一条用户消息**发送（复用
 * ChatView 的正常发送路径，会话/附件逻辑一致）。
 *
 * 状态：`locked`（本轮仍在流式中或已有新一轮在跑）与 `answered`
 * （已作答）都只读置灰，避免重复提交；作答后卡片保留在消息内可回看。
 */

import { useState } from "react";
import type {
  ChatInteraction,
  InteractionField,
  InteractionOption,
} from "../../lib/chat";

/** confirm 未给 options 时的兜底按钮（payload 只带问题时用）。 */
const DEFAULT_CONFIRM_OPTIONS: ReadonlyArray<InteractionOption> = [
  { label: "确认执行", value: "确认执行" },
  { label: "取消", value: "取消" },
];

/** 卡片形态 → 角标文案。 */
const KIND_LABELS: Record<string, string> = {
  clarify: "需要澄清",
  confirm: "确认操作",
  form: "填写信息",
};

/** 字段值 → 发送文本：按「label：值」逐行拼接（跳过留空的可选字段）。 */
function composeAnswer(
  fields: readonly InteractionField[],
  values: Record<string, string>,
): string {
  return fields
    .map((field) => ({ label: field.label, value: (values[field.name] ?? "").trim() }))
    .filter((entry) => entry.value !== "")
    .map((entry) => `${entry.label}：${entry.value}`)
    .join("\n");
}

interface InteractionCardProps {
  /** Rust `ChatEvent::Interact` 的 payload。 */
  payload: ChatInteraction;
  /** 用户已作答（之后只读）。 */
  answered: boolean;
  /** 本轮仍在流式中 / 已有新一轮在跑：暂不可作答。 */
  locked: boolean;
  /** 作答回调：参数即下一条用户消息正文。 */
  onAnswer: (text: string) => void;
}

function InteractionCard({
  payload,
  answered,
  locked,
  onAnswer,
}: InteractionCardProps): React.JSX.Element {
  // 本地「已提交」标记：状态回传是异步的，先锁住避免连点重复发送。
  const [submitted, setSubmitted] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});

  const disabled = locked || answered || submitted;
  const fields = payload.fields ?? [];
  const options = payload.options ?? [];
  const missingRequired = fields.some(
    (field) => field.required && (values[field.name] ?? "").trim() === "",
  );
  const kindLabel = KIND_LABELS[payload.kind] ?? "需要确认";

  function answer(text: string): void {
    if (disabled || text.trim() === "") return;
    setSubmitted(true);
    onAnswer(text.trim());
  }

  function submitForm(): void {
    if (disabled || missingRequired) return;
    const text = composeAnswer(fields, values);
    if (text === "") return;
    answer(text);
  }

  function renderField(field: InteractionField): React.JSX.Element {
    const value = values[field.name] ?? "";
    const setValue = (next: string): void =>
      setValues((prev) => ({ ...prev, [field.name]: next }));
    return (
      <label key={field.name} className="interaction-card__field">
        <span className="interaction-card__label">
          {field.label}
          {field.required && (
            <span className="interaction-card__required" aria-hidden="true">
              *
            </span>
          )}
        </span>
        {field.type === "select" ? (
          <select
            className="cfg-input interaction-card__input"
            value={value}
            disabled={disabled}
            onChange={(event) => setValue(event.target.value)}
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
            className="cfg-input interaction-card__input"
            type={
              field.type === "email"
                ? "email"
                : field.type === "datetime"
                  ? "datetime-local"
                  : "text"
            }
            value={value}
            disabled={disabled}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
      </label>
    );
  }

  return (
    <div className={answered || submitted ? "interaction-card interaction-card--done" : "interaction-card"}>
      <div className="interaction-card__head">
        <span className="status status--info">{kindLabel}</span>
        {(answered || submitted) && (
          <span className="interaction-card__done-note">已作答</span>
        )}
      </div>
      {payload.question !== "" && (
        <p className="interaction-card__question">{payload.question}</p>
      )}
      {(payload.context ?? "") !== "" && (
        <p className="interaction-card__context">{payload.context}</p>
      )}
      {payload.kind === "form" && fields.length > 0 ? (
        <form
          className="interaction-card__form"
          onSubmit={(event) => {
            event.preventDefault();
            submitForm();
          }}
        >
          {fields.map(renderField)}
          <div className="interaction-card__actions">
            <button
              type="submit"
              className="button button--primary"
              disabled={disabled || missingRequired}
            >
              提交
            </button>
            {locked && <span className="interaction-card__hint">正在回复中…</span>}
          </div>
        </form>
      ) : (
        <>
          <div className="interaction-card__options">
            {(payload.kind === "confirm" && options.length === 0
              ? DEFAULT_CONFIRM_OPTIONS
              : options
            ).map((option, index) => (
              <button
                key={`${index}-${option.value}`}
                type="button"
                className="interaction-card__option"
                disabled={disabled}
                onClick={() => answer(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {options.length === 0 && payload.kind !== "confirm" && (
            <p className="interaction-card__hint">可直接在下方输入框回答。</p>
          )}
          {locked && <p className="interaction-card__hint">正在回复中…</p>}
        </>
      )}
    </div>
  );
}

export default InteractionCard;
