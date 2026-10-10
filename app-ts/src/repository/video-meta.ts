/** VideoMetaRepository: data source for tools like list_videos / get_video_summaries (v1 in-memory, MySQL later). */
export interface VideoMeta {
  mediaId: number;
  bvid: string;
  cid?: number;
  title: string;
  pageIndex?: number;
  pageTitle?: string;
  /** ASR transcript (returned when include_content=true) */
  content?: string;
}

export interface VideoMetaRepository {
  getVideoContext(mediaIds: number[], includeContent: boolean): Promise<VideoMeta[]>;
}
