import type { Chunk, ChunkContentType } from "./types.js";
import { config } from "../config/index.js";

/**
 * Semantic chunker: ported from app/services/rag/chunking.py (SemanticChunker).
 * Three-level splitting: outline heading boundaries > blank-line paragraphs > in-paragraph heading patterns > sentences;
 * then greedily merges adjacent short paragraphs up to target_size; overlong paragraphs are split by a sliding sentence window (with overlap).
 */
export interface ChunkOptions {
  targetSize?: number;
  minSize?: number;
  maxSize?: number;
  overlap?: number;
}

export class SemanticChunker {
  private readonly targetSize: number;
  private readonly minSize: number;
  private readonly maxSize: number;
  private readonly overlap: number;

  // Heading patterns: markdown # headings / Chinese-style chapter/section/part ordinal headings / fullwidth-bracket titles / numbered items
  private static readonly TITLE_PATTERN =
    /^(#{1,6}\s+.+|第[一二三四五六七八九十百千0-9]+[章节篇回].*|【[^】]{1,50}】|[0-9]{1,3}[.、][^\s].{0,80})\s*$/u;

  constructor(opts: ChunkOptions = {}) {
    this.targetSize = opts.targetSize ?? config.chunk.targetSize;
    this.minSize = opts.minSize ?? config.chunk.minSize;
    this.maxSize = opts.maxSize ?? config.chunk.maxSize;
    this.overlap = opts.overlap ?? config.chunk.overlap;
  }

  chunk(
    text: string,
    videoTitle = "",
    pageTitle: string | null = null,
    outline: string | null = null,
  ): Chunk[] {
    const cleaned = this.preprocess(text);
    if (cleaned.length === 0) return [];

    const segments = this.splitBySemanticBoundaries(cleaned, outline ?? undefined);
    const merged = this.mergeAndSplitSegments(segments);

    return merged.map((body, i) => {
      const { start, end } = this.locate(cleaned, body, i);
      const sectionTitle = this.detectSectionTitle(body);
      const contentType = this.detectContentType(body, i === 0, pageTitle);
      return {
        displayText: body,
        embeddingText: this.buildEmbeddingText(body, videoTitle, pageTitle, sectionTitle),
        sectionTitle,
        contentType,
        charStart: start,
        charEnd: end,
      };
    });
  }

  // ---------- phase 1: preprocessing ----------

  private preprocess(text: string): string {
    return text
      .split("\n")
      .map((l) => l.replace(/[ \t\u3000]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ---------- phase 2: semantic boundary splitting ----------

  private splitBySemanticBoundaries(text: string, outline?: string): string[] {
    // 1) outline headings locate boundaries
    if (outline) {
      const outlineTitles = outline
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length >= 2 && l.length <= 60);
      const anchors: Array<{ pos: number; title: string }> = [];
      for (const t of outlineTitles) {
        const pos = text.indexOf(t);
        if (pos > 0) anchors.push({ pos, title: t });
      }
      if (anchors.length >= 2) {
        anchors.sort((a, b) => a.pos - b.pos);
        const parts: string[] = [];
        parts.push(text.slice(0, anchors[0].pos).trim());
        for (let i = 0; i < anchors.length; i++) {
          const start = anchors[i].pos;
          const end = i + 1 < anchors.length ? anchors[i + 1].pos : text.length;
          const seg = text.slice(start, end).trim();
          if (seg) parts.push(seg);
        }
        return parts.filter((p) => p.length > 0);
      }
    }

    // 2) blank-line paragraphs
    const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
    if (paragraphs.length <= 1) {
      // 3) in-paragraph heading patterns
      const byTitle = this.splitByTitleLines(text);
      if (byTitle.length > 1) return byTitle;
      // 4) sentences
      return this.splitToSentences(text);
    }
    // When paragraphs are still overlong, split further by headings/sentences
    const result: string[] = [];
    for (const p of paragraphs) {
      if (p.length <= this.maxSize) {
        result.push(p);
      } else {
        result.push(...(this.splitByTitleLines(p).length > 1 ? this.splitByTitleLines(p) : this.splitToSentences(p)));
      }
    }
    return result;
  }

  private splitByTitleLines(text: string): string[] {
    const lines = text.split("\n");
    const parts: string[] = [];
    let current: string[] = [];
    for (const line of lines) {
      if (current.length > 0 && SemanticChunker.TITLE_PATTERN.test(line.trim())) {
        const seg = current.join("\n").trim();
        if (seg) parts.push(seg);
        current = [line];
      } else {
        current.push(line);
      }
    }
    const last = current.join("\n").trim();
    if (last) parts.push(last);
    return parts;
  }

  private splitToSentences(text: string): string[] {
    // Split sentences on CJK/ASCII sentence-ending punctuation (keeping the punctuation)
    const sentences: string[] = [];
    let buf = "";
    for (const ch of text) {
      buf += ch;
      if ("。！？.!?".includes(ch)) {
        sentences.push(buf);
        buf = "";
      }
    }
    if (buf.trim()) sentences.push(buf);
    return sentences.map((s) => s.trim()).filter((s) => s.length > 0);
  }

  // ---------- phase 3: merging and overlong splitting ----------

  private mergeAndSplitSegments(segments: string[]): string[] {
    const chunks: string[] = [];
    let buf = "";
    for (const seg of segments) {
      if (seg.length > this.maxSize) {
        if (buf.trim()) {
          chunks.push(buf.trim());
          buf = "";
        }
        chunks.push(...this.splitLongText(seg));
        continue;
      }
      if (buf.length + seg.length + 1 > this.targetSize && buf.trim()) {
        chunks.push(buf.trim());
        buf = seg;
      } else {
        buf = buf ? `${buf}\n${seg}` : seg;
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
    // Merge an overly short trailing chunk into the previous one
    if (chunks.length >= 2 && chunks[chunks.length - 1].length < this.minSize) {
      const last = chunks.pop() as string;
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n${last}`.slice(0, this.maxSize * 1.2 | 0);
    }
    return chunks;
  }

  private splitLongText(text: string): string[] {
    const sentences = this.splitToSentences(text);
    const chunks: string[] = [];
    let buf = "";
    for (const s of sentences) {
      if (buf.length + s.length > this.maxSize && buf.trim()) {
        chunks.push(buf.trim());
        // overlap: back up by the tail of overlap characters
        buf = buf.length > this.overlap ? buf.slice(-this.overlap) : "";
      }
      buf += s;
    }
    if (buf.trim()) chunks.push(buf.trim());
    return chunks;
  }

  // ---------- metadata ----------

  private locate(text: string, body: string, chunkIndex: number): { start: number; end: number } {
    const start = chunkIndex === 0 ? 0 : text.indexOf(body.slice(0, Math.min(30, body.length)), 0);
    return { start: Math.max(0, start), end: Math.max(0, start) + body.length };
  }

  private detectSectionTitle(body: string): string {
    const firstLine = body.split("\n")[0].trim();
    if (SemanticChunker.TITLE_PATTERN.test(firstLine)) {
      return firstLine.replace(/^#{1,6}\s*/, "").slice(0, 80);
    }
    return "";
  }

  private detectContentType(body: string, isFirst: boolean, pageTitle: string | null): ChunkContentType {
    const head = body.slice(0, 80);
    if (/^(总结|摘要|summary)\b/i.test(head) || /本(视频|期|集)(主要|重点|核心)/.test(head)) return "summary";
    if (isFirst && pageTitle) return "page_intro";
    if (SemanticChunker.TITLE_PATTERN.test(body.split("\n")[0].trim())) return "outline";
    return "content";
  }

  private buildEmbeddingText(
    body: string,
    videoTitle: string,
    pageTitle: string | null,
    sectionTitle: string,
  ): string {
    // Prefix page_title | video_title | section_title (deduplicated)
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const t of [pageTitle ?? "", videoTitle, sectionTitle]) {
      const v = t.trim();
      if (v && !seen.has(v)) {
        seen.add(v);
        parts.push(v);
      }
    }
    const prefix = parts.join(" | ");
    return prefix ? `${prefix}\n${body}` : body;
  }
}
