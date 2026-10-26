/**
 * 输入框上方的已选图片缩略图条：缩略图 + 文件名/大小 + 删除按钮。
 * 生成中禁用删除（发送中的附件集合必须稳定），发送成功后由 ChatView 清空。
 */

import type { ChatImageAttachment } from "../../lib/chat-images";
import { formatImageSize } from "../../lib/chat-images";

interface ImageAttachmentStripProps {
  images: ChatImageAttachment[];
  disabled: boolean;
  onRemove: (id: string) => void;
}

function ImageAttachmentStrip({
  images,
  disabled,
  onRemove,
}: ImageAttachmentStripProps): React.JSX.Element | null {
  if (images.length === 0) return null;
  return (
    <div className="image-chip-row" role="group" aria-label="已附加图片">
      {images.map((image) => (
        <div className="image-chip" key={image.id} title={`${image.name} · ${formatImageSize(image.sizeBytes)}`}>
          <img className="image-chip__thumb" src={image.dataUrl} alt={image.name} />
          <span className="image-chip__meta">
            <span className="image-chip__name">{image.name}</span>
            <span className="image-chip__size">{formatImageSize(image.sizeBytes)}</span>
          </span>
          <button
            type="button"
            className="image-chip__remove"
            aria-label={`移除图片 ${image.name}`}
            title={disabled ? "生成中，暂不能移除" : "移除图片"}
            disabled={disabled}
            onClick={() => onRemove(image.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export default ImageAttachmentStrip;
