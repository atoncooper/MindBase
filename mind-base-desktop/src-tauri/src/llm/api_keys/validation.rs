//! Boundary validation (provider allowlist / key / model / Base URL) and key masking.

// Provider allowlist lives in crate::llm::ai_providers — the same catalog drives
// the settings UI, validation, endpoint resolution and the chat client.

/// Upper bound for any accepted key; real provider keys stay far below this.
const MAX_KEY_LEN: usize = 256;

/// Upper bound for a custom base URL.
const MAX_BASE_URL_LEN: usize = 512;

/// Upper bound for a model identifier.
const MAX_MODEL_LEN: usize = 128;

/// Leading characters kept visible in a masked preview.
const MASK_HEAD: usize = 3;

/// Trailing characters kept visible in a masked preview.
const MASK_TAIL: usize = 4;

/// Minimum length for head+tail masking; shorter keys collapse to stars only.
const MASK_MIN_LEN: usize = MASK_HEAD + MASK_TAIL + 4;

/// Collapse a raw key into a preview that cannot be reversed.
///
/// Long enough keys keep their first [`MASK_HEAD`] and last [`MASK_TAIL`]
/// characters (the tail is what users recognize); anything shorter becomes
/// stars only, never revealing length beyond a coarse hint.
pub(super) fn mask_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() >= MASK_MIN_LEN {
        let head: String = chars[..MASK_HEAD].iter().collect();
        let tail: String = chars[chars.len() - MASK_TAIL..].iter().collect();
        return format!("{head}…{tail}");
    }
    "*".repeat(chars.len())
}

/// Validate and normalize a provider identifier against the allowlist.
pub(super) fn validate_provider(provider: &str) -> Result<String, String> {
    let normalized = provider.trim().to_ascii_lowercase();
    if !crate::llm::ai_providers::is_known(&normalized) {
        return Err(format!("不支持的提供方：{provider:?}"));
    }
    Ok(normalized)
}

/// Validate a user-supplied key before it touches the database.
///
/// Returns the trimmed value; rejects empties, oversized input and anything
/// containing control characters (a pasted key should never have those).
pub(super) fn validate_secret(key: &str) -> Result<String, String> {
    let trimmed = key.trim();
    if trimmed.chars().count() > MAX_KEY_LEN {
        return Err(format!("API Key 过长（上限 {MAX_KEY_LEN} 字符）"));
    }
    if trimmed.chars().any(char::is_control) {
        return Err("API Key 含有非法控制字符，请重新复制粘贴".to_string());
    }
    Ok(trimmed.to_string())
}

/// True when `c` may appear inside a model identifier
/// (`qwen-max`, `openai/gpt-4o`, `deepseek-v3.1`, …).
fn is_model_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | ':' | '@' | '+')
}

/// Validate a model identifier. Empty = unset (use the provider default).
pub(super) fn validate_model(model: &str) -> Result<String, String> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.chars().count() > MAX_MODEL_LEN {
        return Err(format!("模型名称过长（上限 {MAX_MODEL_LEN} 字符）"));
    }
    if !trimmed.chars().all(is_model_char) {
        return Err("模型名称含非法字符（仅允许字母、数字与 . _ - / : @ +）".to_string());
    }
    Ok(trimmed.to_string())
}

/// Validate a custom base URL. Empty = use the provider default endpoint.
pub(super) fn validate_base_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.chars().count() > MAX_BASE_URL_LEN {
        return Err(format!("Base URL 过长（上限 {MAX_BASE_URL_LEN} 字符）"));
    }
    if trimmed.contains(char::is_whitespace) {
        return Err("Base URL 不能包含空白字符".to_string());
    }
    if !(trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("ws://")
        || trimmed.starts_with("wss://"))
    {
        return Err("Base URL 必须以 http://、https://、ws:// 或 wss:// 开头".to_string());
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_keeps_head_and_tail_for_long_keys() {
        assert_eq!(mask_key("sk-abcdef1234567890wxyz"), "sk-…wxyz");
    }

    #[test]
    fn mask_hides_short_keys_entirely() {
        assert_eq!(mask_key("short"), "*****");
        assert_eq!(mask_key("12345678"), "********");
    }

    #[test]
    fn provider_allowlist_normalizes_case_and_space() {
        assert_eq!(
            validate_provider(" DashScope "),
            Ok("dashscope".to_string())
        );
        assert_eq!(
            validate_provider("OPENROUTER"),
            Ok("openrouter".to_string())
        );
    }

    #[test]
    fn provider_allowlist_accepts_coding_plans_and_rejects_unknown() {
        assert!(validate_provider("anthropic").is_ok());
        assert!(validate_provider("zai-coding-cn").is_ok());
        assert!(validate_provider("kimi-coding").is_ok());
        assert!(validate_provider("qwen-token-plan-cn").is_ok());
        assert!(validate_provider("").is_err());
        assert!(validate_provider("dashscope; DROP TABLE api_keys").is_err());
    }

    #[test]
    fn secret_validation_trims_and_accepts_typical_keys() {
        assert_eq!(
            validate_secret("  sk-test-1234567890  "),
            Ok("sk-test-1234567890".to_string())
        );
    }

    #[test]
    fn secret_validation_rejects_oversized_and_control_chars() {
        let oversized = "k".repeat(MAX_KEY_LEN + 1);
        assert!(validate_secret(&oversized).is_err());
        assert!(validate_secret("bad\nkey").is_err());
    }

    #[test]
    fn base_url_accepts_https_and_empty() {
        assert_eq!(
            validate_base_url(" https://dashscope.example/v1 "),
            Ok("https://dashscope.example/v1".to_string())
        );
        assert_eq!(validate_base_url("   "), Ok(String::new()));
    }

    #[test]
    fn base_url_rejects_non_http_and_whitespace() {
        assert!(validate_base_url("ftp://x").is_err());
        assert!(validate_base_url("dashscope.example.com").is_err());
        assert!(validate_base_url("https://a b").is_err());
    }

    #[test]
    fn model_accepts_common_identifiers_and_empty() {
        assert_eq!(validate_model(" qwen-max "), Ok("qwen-max".to_string()));
        assert_eq!(
            validate_model("openai/gpt-4o"),
            Ok("openai/gpt-4o".to_string())
        );
        assert_eq!(validate_model(""), Ok(String::new()));
    }

    #[test]
    fn model_rejects_bad_chars_and_oversize() {
        assert!(validate_model("bad model!").is_err());
        let oversized = "m".repeat(MAX_MODEL_LEN + 1);
        assert!(validate_model(&oversized).is_err());
    }
}
