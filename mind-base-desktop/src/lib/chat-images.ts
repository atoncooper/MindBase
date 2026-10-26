/**
 * 用户主动附加到聊天输入框的图片：文件预校验 / data URL 读取 / 统一契约。
 *
 * 与后端 `validate_user_images` 同规则：最多 4 张、单张解码后 ≤5MB、合计
 * ≤15MB，仅接受 PNG / JPEG / WEBP / GIF 且必须是
 * `data:image/(png|jpeg|jpg|webp|gif);base64,` 前缀。前端预校验只为即时中文
 * 提示，后端仍会独立校验一遍（IPC 参数不可信）。
 */

/** 已读成 data URL、等待随本轮发送的一张图片。 */
export interface ChatImageAttachment {
  /** 本地唯一 id（删除 / React key 用）。 */
  id: string;
  /** 展示用文件名（粘贴的截图没有文件名时按类型生成）。 */
  name: string;
  /** 原始文件字节数（= data URL 解码后的字节数）。 */
  sizeBytes: number;
  /** `data:image/...;base64,...`，发送时原样传给 `chat_ask` 的 images。 */
  dataUrl: string;
}

export const CHAT_IMAGE_MAX_COUNT = 4;
export const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CHAT_IMAGE_MAX_TOTAL_BYTES = 15 * 1024 * 1024;

/** 允许的图片 MIME（webview 对 .jpg 可能给 image/jpeg，也可能给 image/jpg）。 */
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

const IMAGE_EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

let attachmentSeq = 0;

/** 文件 → 规范化 MIME；不是支持的图片返回 ""。 */
export function normalizeImageMime(file: File): string {
  const type = file.type.trim().toLowerCase();
  if (ALLOWED_IMAGE_TYPES.has(type)) {
    return type === "image/jpg" ? "image/jpeg" : type;
  }
  // 少数 webview / 拖拽来源不给 MIME，退回扩展名推断（文件选择器本身已按
  // accept 过滤，这里只是兜底）。
  if (type !== "") return "";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSION_MIME[ext] ?? "";
}

/** 展示名：粘贴的截图往往没有名字。 */
export function imageDisplayName(file: File): string {
  const name = file.name.trim();
  if (name !== "") return name;
  const mime = normalizeImageMime(file);
  const ext = mime === "image/jpeg" ? "jpg" : mime.split("/")[1] || "png";
  return `粘贴图片.${ext}`;
}

/** 人类可读体积（与后端 MB 口径一致：1MB = 1024×1024）。 */
export function formatImageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 单文件预校验：通过返回 null，否则返回中文原因（不含文件名）。 */
export function validateImageFile(file: File): string | null {
  if (normalizeImageMime(file) === "") {
    return "不是支持的图片格式（仅支持 PNG / JPEG / WEBP / GIF）";
  }
  if (file.size === 0) return "文件内容为空";
  if (file.size > CHAT_IMAGE_MAX_BYTES) {
    return `图片过大（${formatImageSize(file.size)}），单张不能超过 5MB`;
  }
  return null;
}

/** 当前已选图片的总字节数。 */
export function totalImageBytes(images: ChatImageAttachment[]): number {
  return images.reduce((sum, image) => sum + image.sizeBytes, 0);
}

/** 从剪贴板 / 拖拽的文件列表里筛出图片文件（其余忽略）。 */
export function pickImageFiles(files: Iterable<File>): File[] {
  return Array.from(files).filter((file) => normalizeImageMime(file) !== "");
}

/**
 * FileReader.readAsDataURL → 规范化为 `data:image/...;base64,...`。
 * 统一前缀是必要的：某些来源的 File 没有 MIME，FileReader 会产出
 * `data:application/octet-stream;base64,...`，后端会按格式非法拒绝。
 */
export function readImageAsDataUrl(file: File): Promise<string> {
  const mime = normalizeImageMime(file);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0 || mime === "") {
        reject(new Error("读取图片失败"));
        return;
      }
      resolve(`data:${mime};base64,${result.slice(comma + 1)}`);
    };
    reader.readAsDataURL(file);
  });
}

/** 生成一条待发送附件记录。 */
export function createImageAttachment(file: File, dataUrl: string): ChatImageAttachment {
  attachmentSeq += 1;
  return {
    id: `chat-image-${Date.now()}-${attachmentSeq}`,
    name: imageDisplayName(file),
    sizeBytes: file.size,
    dataUrl,
  };
}
