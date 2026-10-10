import { z } from "zod";
import { defineTool } from "../base.js";
import type { VideoMetaRepository } from "../../repository/video-meta.js";

/**
 * list_videos: browse the knowledge-base video list (no content).
 * Data goes through VideoMetaRepository (v1 in-memory stub, MySQL video table later).
 */
export function createListVideosTool(videoMeta: VideoMetaRepository) {
  return defineTool({
    name: "list_videos",
    description: "列出知识库中已有视频的标题与基本信息（不含正文）。用于了解数据范围。",
    inputSchema: z.object({
      limit: z.number().int().positive().optional().describe("最多返回条数，默认 20"),
    }),
    async execute(args, ctx) {
      const mediaIds = ctx.scope.mediaIds;
      const videos = await videoMeta.getVideoContext(mediaIds ?? [], false);
      const limited = videos.slice(0, args.limit ?? 20);
      if (limited.length === 0) {
        return "知识库当前没有视频数据。";
      }
      const lines = limited.map(
        (v) => `- [${v.bvid}] ${v.title}${v.pageTitle ? `（${v.pageTitle}）` : ""}`,
      );
      return `知识库共 ${videos.length} 个视频（当前范围 ${limited.length} 个）：\n${lines.join("\n")}`;
    },
  });
}

/** get_video_summaries: view video content with ASR transcripts */
export function createGetVideoSummariesTool(videoMeta: VideoMetaRepository) {
  return defineTool({
    name: "get_video_summaries",
    description: "查看指定范围内视频的完整内容（ASR 正文/摘要）。list_videos 之后需要深入某个视频时调用。",
    inputSchema: z.object({
      limit: z.number().int().positive().optional().describe("最多返回条数，默认 5"),
    }),
    async execute(_args, ctx) {
      const mediaIds = ctx.scope.mediaIds;
      const videos = await videoMeta.getVideoContext(mediaIds ?? [], true);
      const limited = videos.slice(0, 5);
      if (limited.length === 0) {
        return "知识库当前没有视频内容。";
      }
      const lines = limited.map((v) => {
        const content = (v.content ?? "").slice(0, 4000);
        return `## [${v.bvid}] ${v.title}${v.pageTitle ? `（${v.pageTitle}）` : ""}\n${content || "(无内容)"}`;
      });
      return lines.join("\n\n");
    },
  });
}
