//! load_prompt: progressive disclosure of an agent's own prompt tree.

use serde_json::json;

use super::common::spec;
use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};

// ---------------------------------------------------------------------------
// load_prompt — progressive disclosure for the agent's own prompt tree
// (<data>/prompts/<agent>/**.md). The system prompt only carries name +
// description; the model pulls the full body here. base.md is mandatory and
// already in context, so it is never loadable.
// ---------------------------------------------------------------------------

pub(crate) struct LoadPromptTool;

impl LocalTool for LoadPromptTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_LOAD_PROMPT
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let name = super::super::registry::require_string_arg(arguments, "name")?;
        let dir = ctx
            .db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
        crate::agent::prompts::read_prompt_body(&dir, ctx.agent, &name).map(ToolOutput::text)
    }
}

static SPEC_LOAD_PROMPT: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "load_prompt",
        "载入本 agent 的一份可加载提示词的完整内容。可用提示词及其适用场景见系统提示中的「可加载提示词」清单；当任务与某条提示词的描述相关时调用此工具，并遵循载入的指令。",
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "提示词名称（清单中反引号内的相对名，可含子目录如 写作/简历）" }
            },
            "required": ["name"]
        }),
    )
});
