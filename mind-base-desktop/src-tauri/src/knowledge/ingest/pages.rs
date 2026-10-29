//! 单分P 的文本获取、切块与嵌入（不含数据库访问）。

use std::path::Path;

use tauri::ipc::Channel;

use crate::knowledge::bilibili::content as bili_content;
use crate::knowledge::chunker;
use crate::knowledge::vectors;
use crate::llm::embeddings::EmbedClient;
use crate::media::asr::AsrClient;

use super::audio::audio_tmp_path;
use super::transcribe::{transcribe_audio, transcribe_from_combined_video};
use super::{emit, IngestEvent};

/// Identity facts of one 分P, shared by the documents-row writers.
pub(super) struct PageIdentity<'a> {
    pub(super) doc_id: &'a str,
    pub(super) bvid: &'a str,
    pub(super) cid: i64,
    pub(super) page_index: i64,
    pub(super) video_title: &'a str,
    pub(super) page_title: &'a str,
    pub(super) upper_name: &'a str,
}

/// Facts produced by one successful page ingestion.
pub(super) struct PageOutcome {
    pub(super) chunks: Vec<vectors::UpsertChunk>,
    pub(super) char_count: usize,
    pub(super) source: String,
}

/// Text acquisition + chunking + embedding for one 分P (no DB access).
#[allow(clippy::too_many_arguments)]
pub(super) fn ingest_one_page(
    bvid: &str,
    cid: i64,
    page_index: i64,
    brief: &bili_content::VideoBrief,
    media_dir: &Path,
    cookie: &str,
    agent: &ureq::Agent,
    asr_client: &AsrClient,
    embed_client: &EmbedClient,
    channel: &Channel<IngestEvent>,
) -> Result<PageOutcome, String> {
    emit(
        &IngestEvent::PageStep {
            index: page_index,
            step: "conclusion".to_string(),
        },
        channel,
    );
    let outline_titles = bili_content::fetch_outline_titles(agent, Some(cookie), bvid, cid)
        .ok()
        .flatten()
        .unwrap_or_default();

    emit(
        &IngestEvent::PageStep {
            index: page_index,
            step: "audio".to_string(),
        },
        channel,
    );
    let audio_url = bili_content::fetch_audio_url(agent, Some(cookie), bvid, cid)?;

    let text = match audio_url {
        Some(url) => {
            let tmp_dest = audio_tmp_path(media_dir, bvid, cid);
            match transcribe_audio(
                page_index,
                bvid,
                cid,
                media_dir,
                &url,
                cookie,
                &tmp_dest,
                agent,
                asr_client,
                channel,
            ) {
                Ok(text) if !text.trim().is_empty() => {
                    crate::infra::logging::info(
                        "ingest",
                        &format!("page {page_index} ASR ok len={}", text.chars().count()),
                    );
                    text
                }
                other => {
                    // No silent degradation to title+desc: an ASR failure must
                    // surface as a page failure so the real error is visible and
                    // the knowledge base never stores non-transcribed text.
                    let note = match other {
                        Ok(_) => "转写结果为空".to_string(),
                        Err(error) => first_line(&error),
                    };
                    crate::infra::logging::error(
                        "ingest",
                        &format!("page {page_index} ASR failed: {note}"),
                    );
                    return Err(format!("ASR 转写失败：{note}"));
                }
            }
        }
        None => {
            // No separate DASH audio stream could be resolved — instead of
            // failing the page outright, fall back to downloading the combined
            // video and extracting its audio track with ffmpeg, then
            // transcribe that (uploaded to the provider's temp OSS).
            transcribe_from_combined_video(
                page_index,
                bvid,
                cid,
                media_dir,
                cookie,
                agent,
                asr_client,
                channel,
            )?
        }
    };
    let source = "asr".to_string();

    emit(
        &IngestEvent::PageStep {
            index: page_index,
            step: "chunk".to_string(),
        },
        channel,
    );
    let page_title = brief
        .pages
        .iter()
        .find(|page| page.cid == cid)
        .map(|page| page.part_title.clone());
    let chunk_results =
        chunker::chunk_text(&text, &brief.title, page_title.as_deref(), &outline_titles);
    if chunk_results.is_empty() {
        return Err("正文为空，无法入库".to_string());
    }
    let char_count = text.chars().count();

    emit(
        &IngestEvent::PageStep {
            index: page_index,
            step: "embed".to_string(),
        },
        channel,
    );
    let embedding_texts: Vec<String> = chunk_results
        .iter()
        .map(|chunk| chunk.embedding_text.clone())
        .collect();
    let embeddings = embed_client.embed_texts(&embedding_texts)?;

    let chunks: Vec<vectors::UpsertChunk> = chunk_results
        .into_iter()
        .zip(embeddings)
        .enumerate()
        .map(|(index, (chunk, embedding))| vectors::UpsertChunk {
            index: index as i64,
            content: chunk.display_text,
            embedding,
        })
        .collect();

    Ok(PageOutcome {
        chunks,
        char_count,
        source,
    })
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or_default().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_line_extracts_head_of_multiline_errors() {
        assert_eq!(first_line("第一行\n第二行"), "第一行");
        assert_eq!(first_line(""), "");
    }
}
