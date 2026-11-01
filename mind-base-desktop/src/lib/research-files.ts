/**
 * 科研项目「文件」tab 的类型化命令封装（浏览 / 文本 / 图片 / PDF 页 / DOCX HTML）。
 *
 * 路径均为相对项目根、'/' 分隔；绝对路径由 research_file_open_path 返回后交给
 * @tauri-apps/plugin-opener 打开。
 */

import { invoke } from "@tauri-apps/api/core";

/** 项目目录里的一个文件 / 目录条目。 */
export interface ResearchFileEntry {
  /** 相对项目根的路径（'/' 分隔）。 */
  path: string;
  /** 文件 / 目录名（不含父目录）。 */
  name: string;
  isDir: boolean;
  /** 字节数（目录为 0）。 */
  size: number;
  /** 最后修改时间（秒级时间戳）。 */
  modifiedAt: number;
}

/** 文本文件内容（超出上限时截断并置 truncated）。 */
export interface ResearchFileText {
  path: string;
  absolutePath: string;
  text: string;
  size: number;
  truncated: boolean;
}

/** 图片文件内容（base64 原文 + MIME）。 */
export interface ResearchFileImage {
  base64: string;
  mime: string;
  size: number;
}

/** PDF 单页渲染结果（page 从 1 开始）。 */
export interface ResearchFilePdfPage {
  base64: string;
  mime: string;
  page: number;
  pageCount: number;
}

/** DOCX 转换出的 HTML（后端只输出转义后的内容）。 */
export interface ResearchFileDocxHtml {
  html: string;
  size: number;
}

/** 递归列出项目目录（后端已跳过 .git / node_modules 等，目录在前）。 */
export function listResearchFiles(projectId: string): Promise<ResearchFileEntry[]> {
  return invoke<ResearchFileEntry[]>("research_files_list", { projectId });
}

/** 读取文本文件（≤2 MB，超出截断；非 UTF-8 会报中文错误）。 */
export function readResearchFile(projectId: string, path: string): Promise<ResearchFileText> {
  return invoke<ResearchFileText>("research_file_read", { projectId, path });
}

/** 读取图片文件（png/jpg/jpeg/webp/gif/svg）。 */
export function getResearchFileImage(projectId: string, path: string): Promise<ResearchFileImage> {
  return invoke<ResearchFileImage>("research_file_image", { projectId, path });
}

/** 渲染 PDF 的某一页（dpi 默认 144，后端夹取 72..200）。 */
export function getResearchFilePdfPage(
  projectId: string,
  path: string,
  page: number,
  dpi?: number,
): Promise<ResearchFilePdfPage> {
  return invoke<ResearchFilePdfPage>("research_file_pdf_page", {
    projectId,
    path,
    page,
    dpi: dpi ?? null,
  });
}

/** 把 DOCX 转成可安全渲染的 HTML。 */
export function getResearchFileDocxHtml(projectId: string, path: string): Promise<ResearchFileDocxHtml> {
  return invoke<ResearchFileDocxHtml>("research_file_docx_html", { projectId, path });
}

/** 校验路径并返回绝对路径（前端交给 plugin-opener 用系统应用打开）。 */
export function resolveResearchFilePath(projectId: string, path: string): Promise<string> {
  return invoke<string>("research_file_open_path", { projectId, path });
}

/** 把任意本地文件复制进项目文件目录（重名自动加后缀，返回新条目）。 */
export function importResearchFile(projectId: string, sourcePath: string): Promise<ResearchFileEntry> {
  return invoke<ResearchFileEntry>("research_file_import", { projectId, sourcePath });
}

/** 项目文件原始字节（base64 + MIME，供 docx-preview 等原样渲染）。 */
export interface ResearchFileBytes {
  base64: string;
  mime: string;
  size: number;
}

/** 读取项目文件根内某文件的原始字节（≤50MB，路径相对项目根）。 */
export function readResearchFileBytes(projectId: string, path: string): Promise<ResearchFileBytes> {
  return invoke<ResearchFileBytes>("research_file_bytes", { projectId, path });
}
