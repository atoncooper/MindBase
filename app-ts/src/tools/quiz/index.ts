import { z } from "zod";
import { randomUUID } from "node:crypto";
import { defineTool } from "../base.js";
import type { McpToolsClient } from "../../mcp/index.js";

/**
 * Quiz tools: structured output handled by AI SDK tool-calling + zod schema
 * (mirrors Python with_structured_output; retries are naturally handled by the ReAct loop).
 *
 * 红线（对齐 note/board）：quiz 落库一律经 app-quiz-mcp（save_quiz / save_grading），
 * 本层绝不直连 quiz 表或任何仓储实现。Artifacts 仍在客户端组装（ctx.collector →
 * SSE artifact 帧）——data 形状是前端契约，保持与旧直连实现一致。
 */

export interface QuizQuestion {
  question: string;
  options?: string[];
  answer: string;
  explanation: string;
}

export interface Quiz {
  id: string;
  uid: string;
  topic: string;
  questions: QuizQuestion[];
  createdAt: number;
}

export interface QuizGrading {
  id: string;
  uid: string;
  quizId?: string;
  score: number;
  total: number;
  perQuestion: Array<{ index: number; verdict: "correct" | "wrong" | "partial"; feedback: string }>;
  createdAt: number;
}

/** Pull the id out of the MCP tool's result text ("...quiz_id=<uuid>..."). */
function extractId(text: string, key: string): string {
  const m = text.match(new RegExp(`${key}=([0-9a-fA-F-]+)`));
  return m?.[1] ?? "";
}

const questionSchema = z.object({
  question: z.string().min(1).describe("题干"),
  options: z.array(z.string()).optional().describe("选择题选项；问答/填空题省略"),
  answer: z.string().min(1).describe("标准答案"),
  explanation: z.string().min(1).describe("答案解析"),
});

export function createEmitQuizTool(client: McpToolsClient) {
  return defineTool({
    name: "emit_quiz",
    description: "提交生成的整套题目（结构化）。出题完成时必须调用本工具提交，不要用纯文本输出题目。",
    inputSchema: z.object({
      topic: z.string().min(1).describe("题目主题"),
      questions: z.array(questionSchema).min(1).max(20).describe("题目列表，3-8 题为宜"),
    }),
    async execute(args, ctx) {
      if (ctx.uid === undefined) {
        return "生成失败：当前会话没有用户身份。";
      }
      const res = await client.callTool(
        "save_quiz",
        { topic: args.topic, questions: args.questions },
        { uid: ctx.uid },
      );
      if (!res.ok) {
        return `生成失败：${res.error ?? "未知错误"}`;
      }
      const quiz: Quiz = {
        id: extractId(res.content, "quiz_id") || randomUUID(),
        uid: ctx.uid,
        topic: args.topic,
        questions: args.questions,
        createdAt: Date.now(),
      };
      ctx.collector.pushArtifacts([{ kind: "quiz", data: quiz }]);
      return res.content || `已生成 ${args.questions.length} 道关于「${args.topic}」的题目，已提交。`;
    },
  });
}

const verdictSchema = z.object({
  index: z.number().int().min(0).describe("题号（0 起）"),
  verdict: z.enum(["correct", "wrong", "partial"]).describe("判定"),
  feedback: z.string().min(1).describe("该题讲评"),
});

export function createEmitGradingTool(client: McpToolsClient) {
  return defineTool({
    name: "emit_grading",
    description: "提交批改结果（结构化）。批改完成时必须调用本工具提交。",
    inputSchema: z.object({
      quizId: z.string().optional().describe("被批改的 quiz_id（若有）"),
      score: z.number().min(0).max(100).describe("总分 0-100"),
      total: z.number().int().positive().describe("题目总数"),
      perQuestion: z.array(verdictSchema).min(1),
    }),
    async execute(args, ctx) {
      if (ctx.uid === undefined) {
        return "批改失败：当前会话没有用户身份。";
      }
      const res = await client.callTool(
        "save_grading",
        { quiz_id: args.quizId, score: args.score, total: args.total, per_question: args.perQuestion },
        { uid: ctx.uid },
      );
      if (!res.ok) {
        return `批改失败：${res.error ?? "未知错误"}`;
      }
      const grading: QuizGrading = {
        id: extractId(res.content, "grading_id") || randomUUID(),
        uid: ctx.uid,
        quizId: args.quizId,
        score: args.score,
        total: args.total,
        perQuestion: args.perQuestion,
        createdAt: Date.now(),
      };
      ctx.collector.pushArtifacts([{ kind: "quiz_grading", data: grading }]);
      return res.content || `批改已提交：总分 ${args.score}/100。向用户总结得分与主要失分点。`;
    },
  });
}
