//! Token-usage parsing shared by streamed and non-streamed responses.

use super::types::TokenUsage;

/// Parse one provider `usage` object (OpenAI / DashScope compatible shape:
/// `prompt_tokens` / `completion_tokens` / `total_tokens`). Tolerates the
/// `input_tokens` / `output_tokens` aliases and derives a missing total from
/// the two halves; `None` when the payload carries no usable usage object.
pub(crate) fn parse_provider_usage(value: Option<&serde_json::Value>) -> Option<TokenUsage> {
    let object = value?.as_object()?;
    if object.is_empty() {
        return None;
    }
    let pick = |keys: [&str; 2]| {
        keys.iter()
            .find_map(|key| object.get(*key).and_then(serde_json::Value::as_u64))
    };
    let input_tokens = pick(["prompt_tokens", "input_tokens"]).unwrap_or_default();
    let output_tokens = pick(["completion_tokens", "output_tokens"]).unwrap_or_default();
    let total_tokens = object
        .get("total_tokens")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_else(|| input_tokens.saturating_add(output_tokens));
    // Cache-hit counters across providers:
    // - DeepSeek: prompt_cache_hit_tokens
    // - OpenAI:   prompt_tokens_details.cached_tokens
    // - Anthropic: cache_read_input_tokens
    let cached_tokens = object
        .get("cached_tokens")
        .and_then(serde_json::Value::as_u64)
        .or_else(|| {
            object
                .get("prompt_cache_hit_tokens")
                .and_then(serde_json::Value::as_u64)
        })
        .or_else(|| {
            object
                .get("prompt_tokens_details")
                .and_then(|details| details.get("cached_tokens"))
                .and_then(serde_json::Value::as_u64)
        })
        .or_else(|| {
            object
                .get("cache_read_input_tokens")
                .and_then(serde_json::Value::as_u64)
        })
        .unwrap_or_default();
    Some(TokenUsage {
        input_tokens,
        output_tokens,
        total_tokens,
        cached_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_parser_defaults_missing_fields_and_aliases() {
        // OpenAI / DashScope shape, complete.
        let usage = parse_provider_usage(Some(&serde_json::json!({
            "prompt_tokens": 7, "completion_tokens": 5, "total_tokens": 12
        })))
        .expect("usage");
        assert_eq!(
            (usage.input_tokens, usage.output_tokens, usage.total_tokens),
            (7, 5, 12)
        );
        // Missing total is derived from the halves.
        let derived = parse_provider_usage(Some(&serde_json::json!({
            "prompt_tokens": 4, "completion_tokens": 6
        })))
        .expect("usage");
        assert_eq!(derived.total_tokens, 10);
        // Missing fields fall back to 0.
        let partial =
            parse_provider_usage(Some(&serde_json::json!({ "completion_tokens": 3 })))
                .expect("usage");
        assert_eq!(
            (partial.input_tokens, partial.output_tokens, partial.total_tokens),
            (0, 3, 3)
        );
        // input_tokens / output_tokens aliases are accepted too.
        let aliased = parse_provider_usage(Some(&serde_json::json!({
            "input_tokens": 2, "output_tokens": 8
        })))
        .expect("usage");
        assert_eq!(aliased.total_tokens, 10);
        // Nothing usable: no usage frame must never zero out earlier data.
        assert!(parse_provider_usage(None).is_none());
        assert!(parse_provider_usage(Some(&serde_json::json!(null))).is_none());
        assert!(parse_provider_usage(Some(&serde_json::json!({}))).is_none());
    }

    #[test]
    fn cached_tokens_are_parsed_across_providers() {
        // DeepSeek shape.
        let deepseek = parse_provider_usage(Some(&serde_json::json!({
            "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
            "prompt_cache_hit_tokens": 64
        })))
        .expect("usage");
        assert_eq!(deepseek.cached_tokens, 64);
        // OpenAI shape.
        let openai = parse_provider_usage(Some(&serde_json::json!({
            "prompt_tokens": 50, "completion_tokens": 10,
            "prompt_tokens_details": { "cached_tokens": 32 }
        })))
        .expect("usage");
        assert_eq!(openai.cached_tokens, 32);
        // Anthropic shape.
        let anthropic = parse_provider_usage(Some(&serde_json::json!({
            "input_tokens": 80, "output_tokens": 8, "cache_read_input_tokens": 40
        })))
        .expect("usage");
        assert_eq!(anthropic.cached_tokens, 40);
        // Missing cache info stays zero.
        let plain = parse_provider_usage(Some(&serde_json::json!({
            "prompt_tokens": 1, "completion_tokens": 1
        })))
        .expect("usage");
        assert_eq!(plain.cached_tokens, 0);
    }

    #[test]
    fn token_usage_merges_and_serializes_camel_case() {
        let mut total = TokenUsage {
            input_tokens: 1,
            output_tokens: 2,
            total_tokens: 3,
            cached_tokens: 0,
        };
        total.merge(TokenUsage {
            input_tokens: 10,
            output_tokens: 20,
            total_tokens: 30,
            cached_tokens: 5,
        });
        assert_eq!(
            (total.input_tokens, total.output_tokens, total.total_tokens),
            (11, 22, 33)
        );
        let value = serde_json::to_value(total).expect("serialize");
        assert_eq!(value["inputTokens"], 11);
        assert_eq!(value["outputTokens"], 22);
        assert_eq!(value["totalTokens"], 33);
        // The DB column stores exactly this JSON and round-trips losslessly.
        let parsed: TokenUsage = serde_json::from_value(value).expect("deserialize");
        assert_eq!(parsed, total);
        assert!(TokenUsage::default().is_empty());
        assert!(!total.is_empty());
    }
}
