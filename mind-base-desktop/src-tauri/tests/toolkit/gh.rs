//! toolkit::gh 参数构造测试（直接调用 toolkit 包 API，不涉及 agent/harness）。

use mind_base_desktop_lib::toolkit::gh::{self, GhAction};
use serde_json::json;

#[test]
fn action_parse_accepts_aliases() {
    assert_eq!(gh::GhAction::parse(Some("auth")).unwrap(), GhAction::AuthStatus);
    assert_eq!(gh::GhAction::parse(Some("prs")).unwrap(), GhAction::PrList);
    assert_eq!(gh::GhAction::parse(Some("pr_create")).unwrap(), GhAction::PrCreate);
    assert!(gh::GhAction::parse(None).is_err());
    assert!(gh::GhAction::parse(Some("repo_delete")).is_err());
}

#[test]
fn list_args_include_json_fields_and_clamp_limit() {
    let args = gh::build_args(GhAction::PrList, &json!({ "limit": 999 })).unwrap();
    assert_eq!(&args[0..2], &["pr".to_string(), "list".to_string()]);
    assert!(args.contains(&"100".to_string()), "limit clamps: {args:?}");
    assert!(args.iter().any(|arg| arg.contains("number,title,state")));
}

#[test]
fn state_is_validated() {
    assert!(gh::build_args(GhAction::PrList, &json!({ "state": "draft" })).is_err());
    assert!(gh::build_args(GhAction::IssueList, &json!({ "state": "merged" })).is_err());
    assert!(gh::build_args(GhAction::PrList, &json!({ "state": "open" })).is_ok());
}

#[test]
fn view_requires_number_and_create_requires_title() {
    assert!(gh::build_args(GhAction::PrView, &json!({})).is_err());
    assert_eq!(
        gh::build_args(GhAction::PrView, &json!({ "number": 158 })).unwrap()[2],
        "158"
    );
    assert!(gh::build_args(GhAction::PrCreate, &json!({})).is_err());
    let args = gh::build_args(
        GhAction::PrCreate,
        &json!({ "title": "feat: x", "body": "b", "draft": true }),
    )
    .unwrap();
    assert!(args.contains(&"--draft".to_string()));
    assert!(args.contains(&"feat: x".to_string()));
}
