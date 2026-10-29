//! delegate_to_agent: hand a self-contained subtask to a specialist agent.

use serde_json::json;

use super::common::spec;
use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};

// ---------------------------------------------------------------------------
// delegate_to_agent
// ---------------------------------------------------------------------------

pub(crate) struct DelegateToAgentTool;

impl LocalTool for DelegateToAgentTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_DELEGATE
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let Some(delegate) = ctx.delegate.as_deref() else {
            return Err("委托通道不存在：只有顶层 chat 循环可以发起委托".to_string());
        };
        let agent_name = super::super::registry::require_string_arg(arguments, "agent_name")?;
        let query = super::super::registry::require_string_arg(arguments, "query")?;
        if agent_name == "chat" {
            return Err("不能委托给 chat agent(它是顶层路由目标)".to_string());
        }
        let (content, sub_steps) = delegate(&agent_name, &query)?;
        Ok(ToolOutput {
            content,
            hits: Vec::new(),
            sub_steps,
            images: Vec::new(),
        })
    }
}

static SPEC_DELEGATE: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "delegate_to_agent",
        "把一个自包含子任务委托给专职代理执行。可用目标：memory（检索历史对话细节）、note（创建或修改笔记）、code（编写代码，仅生成不执行）、search（查技术库/框架官方文档并联网检索）、academic（学术论文的写作/审查/修改/理解）。",
        json!({
            "type": "object",
            "properties": {
                "agent_name": { "type": "string", "enum": ["memory", "note", "code", "search", "academic"], "description": "目标代理" },
                "query": { "type": "string", "description": "一句清晰自包含的任务描述" }
            },
            "required": ["agent_name", "query"]
        }),
    )
});
