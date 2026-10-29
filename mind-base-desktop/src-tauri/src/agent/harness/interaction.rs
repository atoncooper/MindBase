//! `ask_user` card parsing — the frontend `interact` frame contract.

/// 前端交互契约（ask_user 卡片）—— 与 Web 端 `interact` 帧同形。
///
/// 序列化形态：
/// `{"type":"interact","interact":{"kind":"clarify","question":"…",
///   "options":[{"label":"…","value":"…"}]}}`
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionView {
    /// clarify | confirm | form
    pub kind: String,
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<InteractionOption>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<InteractionField>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

/// 交互卡片的一个可点击选项（点击后 `value` 作为下一条用户消息）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct InteractionOption {
    pub label: String,
    pub value: String,
}

/// 表单交互的一个字段（`type` 是 Rust 关键字，序列化名保持 `type`）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionField {
    pub name: String,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<InteractionOption>>,
}

/// Parse an `ask_user` call into the frontend contract.
///
/// Normalization mirrors the Web implementation: `confirm` without options
/// gets the canonical 确认执行/取消 pair, and form fields default to
/// `type=text` / `required=false`. Invalid JSON degrades to a minimal card
/// instead of failing the turn.
pub(super) fn parse_interaction(arguments: &str) -> InteractionView {
    let value: serde_json::Value = serde_json::from_str(arguments).unwrap_or_default();
    let text = |key: &str| -> Option<String> {
        value
            .get(key)
            .and_then(|raw| raw.as_str())
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    let kind = text("kind").unwrap_or_else(|| "clarify".to_string());
    let mut options = parse_interaction_options(value.get("options"));
    if kind == "confirm" && options.is_none() {
        options = Some(vec![
            InteractionOption {
                label: "确认执行".to_string(),
                value: "确认执行".to_string(),
            },
            InteractionOption {
                label: "取消".to_string(),
                value: "取消".to_string(),
            },
        ]);
    }
    let fields = value
        .get("fields")
        .and_then(|raw| raw.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = item
                        .get("name")
                        .and_then(|raw| raw.as_str())
                        .map(str::trim)
                        .filter(|text| !text.is_empty())?
                        .to_string();
                    let label = item
                        .get("label")
                        .and_then(|raw| raw.as_str())
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| name.clone());
                    Some(InteractionField {
                        name,
                        label,
                        field_type: item
                            .get("type")
                            .and_then(|raw| raw.as_str())
                            .filter(|text| !text.is_empty())
                            .unwrap_or("text")
                            .to_string(),
                        required: item
                            .get("required")
                            .and_then(|raw| raw.as_bool())
                            .unwrap_or(false),
                        options: parse_interaction_options(item.get("options")),
                    })
                })
                .collect::<Vec<_>>()
        })
        .filter(|fields| !fields.is_empty());
    InteractionView {
        kind,
        question: text("question").unwrap_or_default(),
        options,
        fields,
        context: text("context"),
    }
}

/// Normalize an options array; empty / malformed entries are dropped.
fn parse_interaction_options(value: Option<&serde_json::Value>) -> Option<Vec<InteractionOption>> {
    let options: Vec<InteractionOption> = value?
        .as_array()?
        .iter()
        .filter_map(|item| {
            let label = item
                .get("label")
                .and_then(|raw| raw.as_str())
                .map(str::trim)
                .filter(|text| !text.is_empty())?;
            let value = item
                .get("value")
                .and_then(|raw| raw.as_str())
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .unwrap_or(label);
            Some(InteractionOption {
                label: label.to_string(),
                value: value.to_string(),
            })
        })
        .collect();
    if options.is_empty() {
        None
    } else {
        Some(options)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ask_user_arguments_normalize_to_interaction_view() {
        let view = parse_interaction(
            r#"{"kind":"clarify","question":"选哪个方案？","context":"背景","options":[{"label":"方案A","value":"A"},{"label":"B"}]}"#,
        );
        assert_eq!(view.kind, "clarify");
        assert_eq!(view.question, "选哪个方案？");
        assert_eq!(view.context.as_deref(), Some("背景"));
        let options = view.options.expect("options");
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].value, "A");
        assert_eq!(options[1].value, "B", "value falls back to label");
        assert!(view.fields.is_none());
    }

    #[test]
    fn ask_user_confirm_gets_defaults_and_form_fields_default_type() {
        let confirm = parse_interaction(r#"{"kind":"confirm","question":"覆盖文件？"}"#);
        let options = confirm.options.expect("default confirm options");
        assert_eq!(options[0].value, "确认执行");
        assert_eq!(options[1].value, "取消");

        let form = parse_interaction(
            r#"{"kind":"form","question":"补充信息","fields":[{"name":"email","label":"邮箱","type":"email","required":true},{"name":"note"}]}"#,
        );
        let fields = form.fields.expect("fields");
        assert_eq!(fields[0].field_type, "email");
        assert!(fields[0].required);
        assert_eq!(fields[1].field_type, "text");
        assert!(!fields[1].required);
        assert_eq!(fields[1].label, "note", "label falls back to name");

        // 坏 JSON 退化为最小卡片而不是 panic。
        let fallback = parse_interaction("not json");
        assert_eq!(fallback.kind, "clarify");
        assert!(fallback.question.is_empty());
    }
}
