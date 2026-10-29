//! load_skill: progressive disclosure of local SKILL.md packs.

use serde_json::json;

use super::common::{lock_err, spec};
use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};

// ---------------------------------------------------------------------------
// load_skill — progressive disclosure for local SKILL.md packs. The system
// prompt only carries name+description; the model pulls the full body here.
// ---------------------------------------------------------------------------

pub(crate) struct LoadSkillTool;

impl LocalTool for LoadSkillTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_LOAD_SKILL
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let name = super::super::registry::require_string_arg(arguments, "name")?;
        // Lock order (see db.rs): conn first, then data_dir.
        let conn = ctx.db.conn.lock().map_err(lock_err)?;
        let dir = ctx
            .db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
        crate::agent::skills::read_skill_body(&conn, &dir, &name).map(ToolOutput::text)
    }
}

static SPEC_LOAD_SKILL: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "load_skill",
        "载入一个本地技能（skill）的完整指令。可用技能及其适用场景见系统提示中的「可用技能」清单；当用户请求与某技能相关时调用此工具获取执行步骤。",
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "技能名称（清单中反引号内的名字）" }
            },
            "required": ["name"]
        }),
    )
});
