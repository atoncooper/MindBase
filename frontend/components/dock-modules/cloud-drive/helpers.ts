// File-type icon resolution + folder path lookup, shared across the
// cloud-drive panel. Pure helpers — no React, no API calls.

import {
  File, FileArchive, FileImage, FileText, FileVideo,
} from "lucide-react";
import type { CloudFolderTreeItem } from "@/lib/api";

export type FileIconInfo = { Icon: typeof FileText; color: string; label: string };

export function getFileIcon(mimeType?: string): FileIconInfo {
  // Google Drive-inspired palette
  if (!mimeType) return { Icon: File, color: "#5f6368", label: "文件" };
  const m = mimeType.toLowerCase();
  if (m.startsWith("video/"))   return { Icon: FileVideo,   color: "#ea4335", label: "视频" };
  if (m.startsWith("image/"))   return { Icon: FileImage,   color: "#1a73e8", label: "图片" };
  if (m.includes("pdf"))        return { Icon: FileText,    color: "#d93025", label: "PDF"  };
  if (m.includes("wordprocessingml") || m.includes("msword"))
                                 return { Icon: FileText,    color: "#1a73e8", label: "Word" };
  if (m.includes("spreadsheet") || m.includes("excel"))
                                 return { Icon: FileText,    color: "#188038", label: "表格" };
  if (m.includes("presentation") || m.includes("powerpoint"))
                                 return { Icon: FileText,    color: "#f29900", label: "PPT"  };
  if (m.startsWith("text/"))    return { Icon: FileText,    color: "#5f6368", label: "文本" };
  if (m.includes("zip") || m.includes("rar") || m.includes("7z") || m.includes("compress"))
                                 return { Icon: FileArchive, color: "#9334e6", label: "压缩包" };
  return { Icon: File, color: "#5f6368", label: "文件" };
}

export function findFolderPath(
  tree: CloudFolderTreeItem[],
  targetId: number | null,
): CloudFolderTreeItem[] {
  if (targetId == null) return [];
  for (const node of tree) {
    if (node.id === targetId) return [node];
    if (node.children?.length) {
      const sub = findFolderPath(node.children, targetId);
      if (sub.length) return [node, ...sub];
    }
  }
  return [];
}
