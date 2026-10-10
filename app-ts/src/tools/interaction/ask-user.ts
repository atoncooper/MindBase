import { z } from "zod";
import { defineTool } from "../base.js";
import type { InteractionPayload } from "../../context/types.js";

/**
 * ask_user: structured user interaction (non-blocking).
 * The model asks via this tool instead of embedding questions in prose; the payload
 * flows to the frontend as an `interact` SSE frame (confirm card / option chips / form),
 * the user's normalized answer arrives as the next ordinary message, and the ReAct loop
 * stops after this tool (stopOnToolCall in react.ts). Execution stays round-based —
 * no suspended state, no resume protocol.
 */
const optionSchema = z.object({
  label: z.string().min(1).max(40).describe("按钮/选项文案"),
  value: z.string().min(1).max(200).describe("用户点击后作为下一条消息发送的规范化答案"),
});

const fieldSchema = z.object({
  name: z.string().min(1).max(40).describe("字段标识"),
  label: z.string().min(1).max(60).describe("字段展示名"),
  type: z.enum(["text", "email", "datetime", "select"]).optional(),
  required: z.boolean().optional(),
  options: z.array(optionSchema).max(10).optional(),
});

const inputSchema = z.object({
  kind: z.enum(["clarify", "confirm", "form"]).describe(
    "clarify=澄清提问（带选项 chips）；confirm=写操作前确认（确认卡片）；form=多字段表单（一次收集）",
  ),
  question: z.string().min(1).max(500).describe("问题/确认文案，一句话说清要用户决定什么"),
  options: z.array(optionSchema).min(2).max(6).optional().describe("clarify/confirm 的候选选项"),
  fields: z.array(fieldSchema).min(1).max(12).optional().describe("kind=form 时的字段列表"),
  context: z.string().max(500).optional().describe("补充背景：为什么问、确认后会发生什么"),
});

export const createAskUserTool = defineTool({
  name: "ask_user",
  description:
    "向用户发起结构化交互（澄清/确认/表单）。需要用户补充信息、或写操作前需要确认时调用。" +
    "调用后本轮结束等待用户回复；不要替用户作答，也不要在回复文本里重复问题内容。一次只发起一个交互。",
  inputSchema,
  async execute(args, ctx) {
    // normalize optional field attributes (schema uses .optional() instead of .default()
    // to keep the ToolDefinition generic's input/output types aligned)
    const payload: InteractionPayload = {
      ...args,
      fields: args.fields?.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type ?? "text",
        required: f.required ?? false,
        ...(f.options ? { options: f.options } : {}),
      })),
    };
    // confirm 默认给出规范的确认/取消选项（前端渲染按钮，用户点击即规范化回答）
    if (args.kind === "confirm" && (!args.options || args.options.length === 0)) {
      payload.options = [
        { label: "确认执行", value: "确认执行" },
        { label: "取消", value: "取消" },
      ];
    }
    if (args.kind === "clarify" && (!args.options || args.options.length === 0)) {
      return "clarify 交互需要提供 2 个以上选项（前端渲染为可点击 chips）。请补充 options 后重试，或改用普通文本提问。";
    }
    if (args.kind === "form" && (!args.fields || args.fields.length === 0)) {
      return "form 交互需要提供 fields 字段列表。请补充后重试。";
    }
    const accepted = ctx.collector.pushInteraction(payload);
    if (!accepted) {
      return "本轮已发起过一次交互，不能重复发起。请直接结束本轮回答。";
    }
    return "（交互已提交给用户，本轮到此结束。请用一句话简短说明为什么需要用户确认/澄清，不要重复问题选项。）";
  },
});
