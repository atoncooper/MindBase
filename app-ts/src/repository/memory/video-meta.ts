import { randomUUID } from "node:crypto";
import type { VideoMeta, VideoMetaRepository } from "../video-meta.js";

/** In-memory stub: preloaded sample data for integration testing; delete once MySQL is wired in. */
export class MemoryVideoMetaRepository implements VideoMetaRepository {
  private readonly videos = new Map<number, VideoMeta>();

  constructor(seed: VideoMeta[] = []) {
    for (const v of seed) this.videos.set(v.mediaId, v);
  }

  seed(videos: VideoMeta[]): void {
    for (const v of videos) this.videos.set(v.mediaId, v);
  }

  async getVideoContext(mediaIds: number[], includeContent: boolean): Promise<VideoMeta[]> {
    const scoped = mediaIds.length > 0 ? mediaIds : [...this.videos.keys()];
    return scoped
      .map((id) => this.videos.get(id))
      .filter((v): v is VideoMeta => v !== undefined)
      .map((v) => (includeContent ? v : { ...v, content: undefined }));
  }
}

/** Default sample data (for integration testing, explicitly a mock) */
export function defaultSeed(): VideoMeta[] {
  return [
    {
      mediaId: 1,
      bvid: "BV1xx411c7mD",
      cid: 1001,
      title: "（示例数据）RAG 基础：向量检索入门",
      pageIndex: 0,
      pageTitle: "P1",
      content: "这是一条用于本地联调的示例 ASR 正文。",
    },
  ];
}
