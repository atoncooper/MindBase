#[test]
fn diag_find_skill_file() {
    let root = std::env::temp_dir().join(format!("mb-diag-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let nested = root.join("legacy").join("sha").join("deep");
    std::fs::create_dir_all(&nested).unwrap();
    let target = nested.join("SKILL.md");
    std::fs::write(&target, "body").unwrap();
    println!("target exists: {}", target.is_file());
    let found = super::find_skill_file(&root.join("legacy"));
    println!("found: {:?}", found);
    assert!(found.is_some(), "find_skill_file must locate nested SKILL.md");
    std::fs::remove_dir_all(&root).ok();
}
