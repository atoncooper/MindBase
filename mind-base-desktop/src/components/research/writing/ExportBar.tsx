/**
 * 导出结果条（Word / LaTeX / BibTeX 路径 chips，可复制、可关闭）。
 */

import type { DocxExport, LatexExport } from "../../../lib/research";

export interface ExportBarProps {
  wordInfo: DocxExport | null;
  latexInfo: LatexExport | null;
  onCopy: (label: string, text: string) => void;
  onClose: () => void;
}

export default function ExportBar(props: ExportBarProps): React.JSX.Element {
  return (
    <div className="rs-gd__exportbar">
      {props.wordInfo !== null && (
        <span className="rs-gd__exportchip">
          <span className="rs-gd__exportlabel">Word</span>
          <span className="rs-gd__exportpath" title={props.wordInfo.path}>{props.wordInfo.path}</span>
          <button type="button" className="rs-gd__exportcopy" onClick={() => props.onCopy("Word 路径", props.wordInfo === null ? "" : props.wordInfo.path)}>复制</button>
        </span>
      )}
      {props.latexInfo !== null && (
        <>
          <span className="rs-gd__exportchip">
            <span className="rs-gd__exportlabel">LaTeX</span>
            <span className="rs-gd__exportpath" title={props.latexInfo.path}>{props.latexInfo.path}</span>
            <button type="button" className="rs-gd__exportcopy" onClick={() => props.onCopy("LaTeX 路径", props.latexInfo === null ? "" : props.latexInfo.path)}>复制</button>
          </span>
          {props.latexInfo.bibPath !== "" && (
            <span className="rs-gd__exportchip">
              <span className="rs-gd__exportlabel">BibTeX</span>
              <span className="rs-gd__exportpath" title={props.latexInfo.bibPath}>{props.latexInfo.bibPath}</span>
              <button type="button" className="rs-gd__exportcopy" onClick={() => props.onCopy("BibTeX 路径", props.latexInfo === null ? "" : props.latexInfo.bibPath)}>复制</button>
            </span>
          )}
        </>
      )}
      <button type="button" className="rs-gd__exportclose" aria-label="关闭导出结果" onClick={props.onClose}>×</button>
    </div>
  );
}
