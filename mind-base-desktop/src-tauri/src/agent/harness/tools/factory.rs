//! create_agent / list_agents：主 agent 自建自定义子代理并复用。
//!
//! 自定义 agent = 持久化的「名字 + 描述 + 角色提示词」；委托时由 chat 的 ReAct
//! 能力执行（共享知识库、历史、文件工具），角色提示词包成任务说明注入。

use serde_json::{json, Value};

use crate::agent::custom_agents;
use crate::agent::agents::AgentKind;

use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};
use super::common::spec;

pub(crate) struct CreateAgentTool;

static SPEC_CREATE_AGENT: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "create_agent",
        "创建一个自定义子代理（自己给自己造一个专项打工者），持久化到数据库，之后可用 \
         delegate_to_agent 按名字反复调用。适用：固定角色的重复工作（数据清洗、\
         文献核对、前端走查、周报整理等）。参数：name（小写字母/数字/-/_）、description、\
         system_prompt（角色与工作方式，越具体越稳定）。可选 task：创建后立即执行一次并把结果返回。\
         自定义 agent 使用 chat 的工具集（共享知识库/历史/文件），不继承当前对话的历史。",
        json!({
            "type": "object",
            "required": ["name", "system_prompt"],
            "properties": {
                "name": {"type": "string", "description": "agent 名称（小写 slug，2..=40，如 data-cleaner）"},
                "description": {"type": "string", "description": "一句话用途（列表展示用）"},
                "system_prompt": {"type": "string", "description": "角色与工作方式：职责、边界、输出格式、检查清单（≤4000 字）"},
                "task": {"type": "string", "description": "可选：创建后立即交给它执行的任务；留空则只创建"}
            }
        }),
    )
});

impl LocalTool for CreateAgentTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_CREATE_AGENT
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let description = value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let system_prompt = value
            .get("system_prompt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let task = value
            .get("task")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty());
        let now = crate::automation::now_secs();
        let agent = {
            let conn = ctx
                .db
                .conn
                .lock()
                .map_err(|err| format!("failed to acquire database lock: {err}"))?;
            custom_agents::upsert(&conn, name, description, system_prompt, now)?
        };
        let mut out = format!(
            "已保存自定义 agent「{}」（{}）\n后续用 delegate_to_agent(agent_name=\"{}\"）调用。",
            agent.name,
            if agent.description.is_empty() {
                "无描述"
            } else {
                agent.description.as_str()
            },
            agent.name
        );
        if let Some(task) = task {
            let Some(delegate) = ctx.delegate.as_deref() else {
                return Err(format!(
                    "{out}\n但当前运行环境没有委托通道，无法立即执行；请在主对话中调用 delegate_to_agent。"
                ));
            };
            let (answer, sub_steps) = delegate(&agent.name, task)?;
            out.push_str(&format!(
                "\n\n本次执行（{} 步）：\n{}",
                sub_steps.len(),
                answer
            ));
        }
        Ok(ToolOutput {
            content: out,
            hits: Vec::new(),
            sub_steps: Vec::new(),
            images: Vec::new(),
        })
    }
}

pub(crate) struct ListAgentsTool;

static SPEC_LIST_AGENTS: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "list_agents",
        "列出可委托的 agent：内置（memory/note/code/search/academic/research）+ 主 agent \
         自建的自定义 agent（create_agent 创建）。用于决定下一步委托给谁。",
        json!({"type": "object", "properties": {}}),
    )
});

impl LocalTool for ListAgentsTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_LIST_AGENTS
    }

    fn execute(&self, ctx: &ToolContext, _arguments: &str) -> Result<ToolOutput, String> {
        let mut out = String::from("内置 agent：\n");
        for kind in [
            AgentKind::Memory,
            AgentKind::Note,
            AgentKind::Code,
            AgentKind::Search,
            AgentKind::Academic,
            AgentKind::Research,
        ] {
            out.push_str(&format!("- {}：{}\n", kind.name(), kind.description()));
        }
        let custom = {
            let conn = ctx
                .db
                .conn
                .lock()
                .map_err(|err| format!("failed to acquire database lock: {err}"))?;
            custom_agents::list(&conn)?
        };
        if custom.is_empty() {
            out.push_str("自定义 agent：暂无（可用 create_agent 创建）");
        } else {
            out.push_str("自定义 agent：\n");
            for agent in custom {
                out.push_str(&format!(
                    "- {}：{}（角色设定 {} 字）\n",
                    agent.name,
                    if agent.description.is_empty() {
                        "无描述"
                    } else {
                        agent.description.as_str()
                    },
                    agent.system_prompt.chars().count()
                ));
            }
        }
        Ok(ToolOutput::text(out))
    }
}
