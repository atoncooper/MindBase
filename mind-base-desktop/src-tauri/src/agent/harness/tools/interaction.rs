//! Runtime-intercepted interaction tools: plan (task checkpoints) and ask_user (structured prompts).

use serde_json::json;

use super::common::spec;
use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};

// ---------------------------------------------------------------------------
// plan — task planning tool (复杂任务的计划/检查点机制)。调用在 react_loop
// 中被本地拦截（运行时状态机）；此处的 execute 仅作兜底，正常不会触达。
// ---------------------------------------------------------------------------

pub(crate) struct PlanTool;

impl LocalTool for PlanTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_PLAN
    }

    fn execute(&self, _ctx: &ToolContext, _arguments: &str) -> Result<ToolOutput, String> {
        Err("plan 由运行时处理".to_string())
    }
}

static SPEC_PLAN: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "plan",
        "创建与维护任务计划（复杂任务的多步规划与检查点）。         action=create：把目标拆解为 3-6 个可检查的步骤并创建计划；         action=update：更新某一步的状态（in_progress/done/failed/skipped），每步完成即形成检查点；         action=revise：某步失败后修订剩余计划（需 reason），修订最多 3 次。         计划状态会实时展示给用户，请在复杂任务开始时先创建计划。",
        json!({
            "type": "object",
            "required": ["action"],
            "properties": {
                "action": { "type": "string", "description": "create | update | revise" },
                "steps": { "type": "array", "items": { "type": "string" }, "description": "步骤描述列表（create/revise 时必填）" },
                "step": { "type": "integer", "description": "步骤编号（update 时必填，1 起）" },
                "status": { "type": "string", "description": "步骤状态：pending | in_progress | done | failed | skipped（update 时）" },
                "note": { "type": "string", "description": "备注（如失败原因、完成说明）" },
                "reason": { "type": "string", "description": "修订原因（revise 时必填）" }
            }
        }),
    )
});

// ---------------------------------------------------------------------------
// ask_user — 结构化用户交互（澄清 / 确认 / 表单）。与 plan 一样，调用在
// react_loop 中被本地拦截：构造 InteractionView 推给前端卡片、本轮立即结束
// 等用户回答；此处的 execute 仅作兜底，正常不会触达。
// ---------------------------------------------------------------------------

pub(crate) struct AskUserTool;

impl LocalTool for AskUserTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_ASK_USER
    }

    fn execute(&self, _ctx: &ToolContext, _arguments: &str) -> Result<ToolOutput, String> {
        Err("ask_user 由运行时处理".to_string())
    }
}

static SPEC_ASK_USER: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "ask_user",
        "向用户发起结构化交互（澄清 / 确认 / 表单），前端渲染为可点击卡片。                   需要用户补充关键信息（clarify）、写操作前需要确认（confirm）、或一次收集多个字段（form）时调用；                   调用后**本轮立即结束**，等用户回答后再继续。一次只发起一个交互，不要替用户作答，         也不要在回复正文里重复卡片里的问题。",
        json!({
            "type": "object",
            "required": ["kind", "question"],
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": ["clarify", "confirm", "form"],
                    "description": "clarify=澄清提问（带选项）；confirm=写操作前确认（确认卡片）；form=多字段表单（一次收集）"
                },
                "question": {
                    "type": "string",
                    "description": "问题/确认文案，一句话说清要用户决定什么"
                },
                "options": {
                    "type": "array",
                    "description": "clarify/confirm 的候选选项（用户点击后其 value 作为下一条消息发送）",
                    "items": {
                        "type": "object",
                        "required": ["label", "value"],
                        "properties": {
                            "label": { "type": "string", "description": "按钮/选项文案" },
                            "value": { "type": "string", "description": "规范化答案（点击后作为下一条用户消息）" }
                        }
                    }
                },
                "fields": {
                    "type": "array",
                    "description": "kind=form 时的字段列表",
                    "items": {
                        "type": "object",
                        "required": ["name", "label"],
                        "properties": {
                            "name": { "type": "string", "description": "字段标识" },
                            "label": { "type": "string", "description": "字段展示名" },
                            "type": { "type": "string", "enum": ["text", "email", "datetime", "select"] },
                            "required": { "type": "boolean", "description": "是否必填（默认 false）" },
                            "options": {
                                "type": "array",
                                "description": "type=select 时的候选选项",
                                "items": {
                                    "type": "object",
                                    "required": ["label", "value"],
                                    "properties": {
                                        "label": { "type": "string" },
                                        "value": { "type": "string" }
                                    }
                                }
                            }
                        }
                    }
                },
                "context": {
                    "type": "string",
                    "description": "补充背景：为什么问、确认后会发生什么"
                }
            }
        }),
    )
});
