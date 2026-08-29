/**
 * 工作区搜索卡：查询 → 向量化 → 本地余弦检索 → 命中卡片列表。
 * 命中项显示来源视频 / 分P / 相似度与内容摘要，可一键打开 B 站页面。
 */

import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { searchKnowledge } from "../../lib/knowledge";
import type { KnowledgeHit } from "../../lib/knowledge";
import { SETTINGS_API_HASH, navigate } from "../../lib/router";
import { toErrorMessage } from "../../lib/updater";

/** Cosine similarity in [-1, 1] → display percentage. */
function scoreLabel(score: number): string {
  return `${Math.max(0, Math.round(score * 100))}%`;
}

function SearchCard() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(): Promise<void> {
    const trimmed = query.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError("");
    try {
      setHits(await searchKnowledge(trimmed));
    } catch (err) {
      setHits(null);
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="card__title">
        <span className="card__index">01</span>语义搜索
      </h2>
      <div className="ws-search">
        <input
          type="text"
          className="cfg-input"
          placeholder="在已入库的知识库中搜索…"
          value={query}
          disabled={busy}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void run();
          }}
        />
        <button
          type="button"
          className="button button--primary"
          disabled={busy || query.trim() === ""}
          onClick={() => void run()}
        >
          {busy ? "搜索中…" : "搜索"}
        </button>
      </div>

      {error !== "" && (
        <p className="error-text">
          {error}
          {/API 设置/.test(error) && (
            <>
              {" "}
              <button type="button" className="button" onClick={() => navigate(SETTINGS_API_HASH)}>
                前往 API 设置
              </button>
            </>
          )}
        </p>
      )}
      {hits !== null && error === "" && hits.length === 0 && (
        <p className="hint-text">没有命中。先到「收藏夹」把视频入库，或换个说法再试。</p>
      )}
      {hits !== null && hits.length > 0 && (
        <ul className="ws-hits">
          {hits.map((hit) => (
            <li key={`${hit.docId}:${hit.chunkIndex}`} className="ws-hit">
              <div className="ws-hit__head">
                <span className="ws-hit__title">
                  {hit.videoTitle}
                  {hit.pageTitle !== "" ? ` · ${hit.pageTitle}` : ""}
                </span>
                <span className="status">{scoreLabel(hit.score)}</span>
              </div>
              <p className="ws-hit__content">{hit.content}</p>
              {hit.url !== "" && (
                <button
                  type="button"
                  className="button"
                  onClick={() => void openUrl(hit.url)}
                >
                  打开视频
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default SearchCard;
