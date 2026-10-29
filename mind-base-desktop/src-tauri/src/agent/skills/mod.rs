//! Skills — local SKILL.md packs the chat agent can load on demand.
//!
//! Format mirrors Claude Code: `<data_dir>/skills/<name>/SKILL.md` with a
//! tiny YAML frontmatter (`name` / `description`) followed by Markdown
//! instructions. Discovery is directory-driven: drop a folder in, it shows
//! up on the next scan — no restart, no registration. Per-skill enabled
//! flags persist in SQLite `skill_settings` (default ON) and survive
//! renames of the folder only by name match.
//!
//! Progressive disclosure (same shape as the reference implementation):
//! the chat system prompt carries only the name+description digest; the
//! model pulls the full body through the `load_skill` tool when relevant.

mod commands;
mod install;
mod parse;
mod paths;
mod state;
mod store;

// Commands are re-exported together with the `#[tauri::command]` wrapper
// macros they generate, so `generate_handler!` keeps resolving them via this path.
pub use self::commands::skills_list;
pub use self::commands::skills_open_dir;
pub use self::commands::skills_set_enabled;
pub use self::commands::skills_uninstall;
pub use self::commands::{
    __cmd__skills_list, __cmd__skills_open_dir, __cmd__skills_set_enabled,
    __cmd__skills_uninstall, __tauri_command_name_skills_list,
    __tauri_command_name_skills_open_dir, __tauri_command_name_skills_set_enabled,
    __tauri_command_name_skills_uninstall,
};
pub use self::install::skills_install_from_path;
pub use self::install::skills_install_zip;
pub use self::install::{
    __cmd__skills_install_from_path, __cmd__skills_install_zip,
    __tauri_command_name_skills_install_from_path, __tauri_command_name_skills_install_zip,
};
pub use self::store::skills_store_install;
pub use self::store::skills_store_search;
pub use self::store::{
    __cmd__skills_store_install, __cmd__skills_store_search,
    __tauri_command_name_skills_store_install, __tauri_command_name_skills_store_search,
};
pub use self::parse::SkillMeta;
pub(crate) use self::parse::{parse_skill, scan_skills};
pub(crate) use self::state::{enabled_skills_digest, read_skill_body};

// Types only used inside this package today; kept re-exported so their
// historical `crate::agent::skills::*` paths stay valid.
#[allow(unused_imports)]
pub(crate) use self::parse::ParsedSkill;
#[allow(unused_imports)]
pub use self::store::StoreRepo;
