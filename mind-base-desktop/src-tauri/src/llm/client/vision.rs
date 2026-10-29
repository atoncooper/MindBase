//! Vision capability heuristic and image-attachment fallbacks for chat requests.

use super::types::ChatMessage;

/// Conservative name-based vision capability heuristic. Models whose name
/// matches any of these fragments are treated as able to consume image
/// parts; everything else stays text-only.
pub(crate) fn model_supports_vision(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    [
        "qwen-vl",
        "qwen2-vl",
        "qwen2.5-vl",
        "qvq",
        "gpt-4o",
        "gpt-4.1",
        "gpt-4-turbo",
        "chatgpt-4o",
        "o3",
        "o4",
        "claude-3",
        "claude-sonnet",
        "claude-opus",
        "claude-haiku",
        "gemini",
        "glm-4v",
        "glm-4.5v",
        "pixtral",
        "llava",
        "internvl",
        "doubao-1.5-vision",
        "doubao-seed",
    ]
    .iter()
    .any(|marker| model.contains(marker))
}

/// Does any message in the sequence carry image attachments?
pub(super) fn has_images(messages: &[ChatMessage]) -> bool {
    messages.iter().any(|message| !message.images.is_empty())
}

/// Clone the sequence with every image attachment removed — the fallback
/// shape used when a provider rejects multimodal content.
pub(super) fn strip_images(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    messages
        .iter()
        .map(|message| {
            let mut stripped = message.clone();
            stripped.images = Vec::new();
            stripped
        })
        .collect()
}
