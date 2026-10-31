//! DeepSeek DSML tool-call fallback.
//!
//! Some OpenAI-compatible gateways return DeepSeek native tool syntax as plain
//! assistant text instead of an OpenAI tool_calls array, e.g.
//!
//! <|DSML|tool_calls>
//! <|DSML|invoke name="academic_literature">
//! <|DSML|parameter name="action">search</|DSML|parameter>
//! </|DSML|invoke>
//! </|DSML|tool_calls>
//!
//! Without this fallback the loop sees a final answer containing markup and
//! never executes the tools. Parse it into ToolCallReq, strip the markup.

use serde_json::{Map, Value};

use super::types::ToolCallReq;

/// Normalize fullwidth pipes and tolerate an optional space after DSML tags.
fn normalize(text: &str) -> String {
    let mut out = text.replace('｜', "|");
    out = out.replace("<||DSML||", "<|DSML|");
    out = out.replace("</||DSML||", "</|DSML|");
    out = out.replace("<|DSML| ", "<|DSML|");
    out = out.replace("</|DSML| ", "</|DSML|");
    out
}

fn find_tag_end(text: &str, from: usize) -> Option<usize> {
    text[from..].find('>').map(|offset| from + offset)
}

fn parse_parameter(text: &str, start: usize) -> Option<(String, String, usize)> {
    let name_key = "name=\"";
    let name_start = text[start..].find(name_key)? + start + name_key.len();
    let name_end = text[name_start..].find('"')? + name_start;
    let name = text[name_start..name_end].to_string();
    let tag_end = find_tag_end(text, name_end)?;
    let value_start = tag_end + 1;
    let close = "</|DSML|parameter>";
    let value_end = text[value_start..].find(close)? + value_start;
    let value = text[value_start..value_end].to_string();
    Some((name, value, value_end + close.len()))
}

/// Remove every DSML tag, leaving only human-visible text.
fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find('<') {
        out.push_str(&rest[..pos]);
        let after = &rest[pos..];
        let is_dsml = after.starts_with("<|DSML|") || after.starts_with("</|DSML|");
        if is_dsml {
            match find_tag_end(after, 0) {
                Some(end) => rest = &after[end + 1..],
                None => return out,
            }
        } else {
            out.push('<');
            rest = &after[1..];
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// Returns (cleaned content, tool calls); None when no DSML invoke markers.
pub(super) fn parse(content: &str) -> Option<(String, Vec<ToolCallReq>)> {
    if !content.contains("DSML") {
        return None;
    }
    let text = normalize(content);
    let invoke_open = "<|DSML|invoke";
    let invoke_close = "</|DSML|invoke>";
    if !text.contains(invoke_open) {
        return None;
    }
    let mut calls = Vec::new();
    let mut cursor = 0usize;
    while let Some(relative) = text[cursor..].find(invoke_open) {
        let start = cursor + relative;
        let Some(tag_end) = find_tag_end(&text, start) else {
            break;
        };
        let name_key = "name=\"";
        let Some(name_offset) = text[start..tag_end].find(name_key) else {
            cursor = tag_end + 1;
            continue;
        };
        let name_start = start + name_offset + name_key.len();
        let Some(name_end) = text[name_start..].find('"').map(|offset| name_start + offset) else {
            cursor = tag_end + 1;
            continue;
        };
        let name = text[name_start..name_end].to_string();
        let body_start = tag_end + 1;
        let Some(body_end) = text[body_start..].find(invoke_close).map(|offset| body_start + offset)
        else {
            break;
        };
        let mut arguments = Map::new();
        let mut param_cursor = body_start;
        while let Some(param_rel) = text[param_cursor..body_end].find("<|DSML|parameter") {
            let param_start = param_cursor + param_rel;
            let Some((key, raw_value, next)) = parse_parameter(&text, param_start) else {
                break;
            };
            let value =
                serde_json::from_str::<Value>(&raw_value).unwrap_or(Value::String(raw_value));
            arguments.insert(key, value);
            param_cursor = next.min(body_end);
        }
        calls.push(ToolCallReq {
            id: format!("dsml-call-{}", calls.len() + 1),
            name,
            arguments: Value::Object(arguments).to_string(),
        });
        cursor = body_end + invoke_close.len();
    }
    if calls.is_empty() {
        return None;
    }
    Some((strip_tags(&text), calls))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dsml_invoke_blocks_into_tool_calls() {
        let text = "需要检索。\n<|DSML|tool_calls>\n<|DSML|invoke name=\"academic_literature\">\n<|DSML|parameter name=\"action\">search</|DSML|parameter>\n<|DSML|parameter name=\"limit\">10</|DSML|parameter>\n<|DSML|parameter name=\"query\">MemGPT memory</|DSML|parameter>\n</|DSML|invoke>\n</|DSML|tool_calls>";
        let (cleaned, calls) = parse(text).expect("dsml parsed");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "academic_literature");
        assert!(calls[0].arguments.contains("\"action\":\"search\""));
        assert!(calls[0].arguments.contains("\"limit\":10"));
        assert!(!cleaned.contains("DSML"));
        assert!(cleaned.contains("需要检索"));
    }

    #[test]
    fn tolerates_fullwidth_pipes_and_multiple_invokes() {
        let text = "调用：<｜｜DSML｜｜ invoke name=\"web_search\"><｜｜DSML｜｜ parameter name=\"query\">LLM memory survey</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke><｜｜DSML｜｜ invoke name=\"academic_literature\"><｜｜DSML｜｜ parameter name=\"action\">search</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>";
        let (cleaned, calls) = parse(text).expect("dsml parsed");
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "web_search");
        assert_eq!(calls[1].name, "academic_literature");
        assert!(!cleaned.contains("DSML"));
    }
}
