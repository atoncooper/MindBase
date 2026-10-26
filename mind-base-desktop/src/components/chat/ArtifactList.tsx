/**
 * 本轮产物列表（ChatEvent::Artifact）：generate_resume / generate_slides 等
 * 生成的文件落在数据目录 exports/ 下，这里以紧凑行展示并在系统默认程序里打开。
 *
 * 只渲染、不落库：产物只在产生它的那一轮可见（与后端事件语义一致）。
 */

import { openPath } from "@tauri-apps/plugin-opener";
import type { ChatArtifact } from "../../lib/chat";
import { formatBytes } from "../../lib/exports";
import { useToast } from "../../lib/toast";
import { toErrorMessage } from "../../lib/updater";

/** 常见类型 → 短徽标（未知类型回退为大写扩展名）。 */
const KIND_BADGES: Record<string, string> = {
  markdown: "MD",
  md: "MD",
  pptx: "PPT",
  ppt: "PPT",
  pdf: "PDF",
  docx: "DOC",
  xlsx: "XLS",
  csv: "CSV",
  png: "PNG",
  jpg: "JPG",
  jpeg: "JPG",
  svg: "SVG",
  html: "HTML",
  txt: "TXT",
};

function kindBadge(kind: string): string {
  const key = kind.trim().toLowerCase();
  if (key === "") return "文件";
  return KIND_BADGES[key] ?? key.toUpperCase();
}

/** 产物修改时间（epoch 秒）→ 本地短日期。 */
function modifiedLabel(epochSecs: number): string {
  if (epochSecs <= 0) return "";
  return new Date(epochSecs * 1000).toLocaleDateString();
}

interface ArtifactListProps {
  artifacts: ChatArtifact[];
}

function ArtifactList({ artifacts }: ArtifactListProps): React.JSX.Element {
  const toast = useToast();

  async function open(path: string): Promise<void> {
    try {
      await openPath(path);
    } catch (err) {
      // 打不开只轻声提示，不打断对话。
      toast.error(toErrorMessage(err), { title: "打开失败", duration: 3000 });
    }
  }

  if (artifacts.length === 0) return <></>;

  return (
    <div className="artifact-list">
      <p className="artifact-list__head">本轮产出 · {artifacts.length} 个文件</p>
      <ul className="artifact-list__rows">
        {artifacts.map((artifact) => {
          const modified = modifiedLabel(artifact.modifiedAt);
          return (
            <li className="artifact-row" key={artifact.path}>
              <span className="artifact-row__badge" title={artifact.kind}>
                {kindBadge(artifact.kind)}
              </span>
              <span className="artifact-row__body">
                <span className="artifact-row__name" title={artifact.path}>
                  {artifact.name}
                </span>
                <span className="artifact-row__meta">
                  {formatBytes(artifact.sizeBytes)}
                  {modified !== "" ? ` · ${modified}` : ""}
                </span>
              </span>
              <button
                type="button"
                className="button artifact-row__open"
                title="用系统默认程序打开"
                onClick={() => void open(artifact.path)}
              >
                打开
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default ArtifactList;
