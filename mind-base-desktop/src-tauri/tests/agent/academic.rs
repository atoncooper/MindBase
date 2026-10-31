//! 学术工具：文献导入/列表 + 项目简报/阶段流转。

use mind_base_desktop_lib::TestHarness;

#[test]
fn academic_tools_are_registered_for_chat() {
    let h = TestHarness::new("agent-academic-registry");
    let names = h.registered_tools();
    for expected in ["academic_literature", "academic_project", "web_search"] {
        assert!(
            names.iter().any(|name| name == expected),
            "tool {expected} missing from registry"
        );
    }
}

#[test]
fn project_brief_and_stage_update_work_on_a_real_project() {
    let h = TestHarness::new("agent-academic-project");
    let project_id = h.create_research_project("测试科研项目");
    let brief = h
        .run_tool(
            "chat",
            "academic_project",
            &format!("{{\"action\":\"brief\",\"project_id\":\"{project_id}\"}}"),
        )
        .expect("brief");
    assert!(brief.contains("测试科研项目"), "brief missing title: {brief}");

    h.run_tool(
        "chat",
        "academic_project",
        &format!(
            "{{\"action\":\"stage_update\",\"project_id\":\"{project_id}\",\"stage\":\"topic\",\"status\":\"active\"}}"
        ),
    )
    .expect("stage_update");
    assert_eq!(h.research_stage_status(&project_id, "topic"), "active");
}

#[test]
fn literature_import_and_list_round_trip() {
    let h = TestHarness::new("agent-academic-literature");
    let project_id = h.create_research_project("文献测试项目");
    let bibtex = "@article{smith2020rag, title={Retrieval Augmented Generation}, author={Smith, John}, year={2020}, journal={Journal of RAG}}";
    let imported = h
        .run_tool(
            "chat",
            "academic_literature",
            &serde_json::json!({
                "action": "import",
                "project_id": project_id,
                "format": "bibtex",
                "content": bibtex,
            })
            .to_string(),
        )
        .expect("import");
    assert!(imported.contains("已导入 1 条"), "unexpected import output: {imported}");

    let listed = h
        .run_tool(
            "chat",
            "academic_literature",
            &serde_json::json!({"action": "list", "project_id": project_id}).to_string(),
        )
        .expect("list");
    assert!(listed.contains("smith2020rag"), "list missing cite key: {listed}");
    assert!(listed.contains("Retrieval Augmented Generation"));
}

#[test]
fn missing_project_is_reported_clearly() {
    let h = TestHarness::new("agent-academic-missing");
    let err = h
        .run_tool(
            "chat",
            "academic_literature",
            "{\"action\":\"list\",\"project_id\":\"no-such-project\"}",
        )
        .expect_err("missing project must fail");
    assert!(err.contains("研究项目不存在"), "unexpected: {err}");
}

#[test]
fn project_list_and_manuscript_round_trip() {
    let h = TestHarness::new("agent-academic-manuscript");
    let project_id = h.create_research_project("稿件测试项目");

    let listed = h
        .run_tool("chat", "academic_project", "{\"action\":\"list\"}")
        .expect("project list");
    assert!(listed.contains(&project_id), "project list missing id: {listed}");
    assert!(listed.contains("稿件测试项目"));

    let written = h
        .run_tool(
            "chat",
            "academic_manuscript",
            &serde_json::json!({
                "action": "write",
                "project_id": project_id,
                "section": "3 方法",
                "content": "我们提出了一种方法。\n",
            })
            .to_string(),
        )
        .expect("manuscript write");
    assert!(written.contains("已写入章节"), "unexpected: {written}");

    let read = h
        .run_tool(
            "chat",
            "academic_manuscript",
            &serde_json::json!({
                "action": "read",
                "project_id": project_id,
                "section": "3 方法",
            })
            .to_string(),
        )
        .expect("manuscript read");
    assert!(read.contains("我们提出了一种方法"), "read missing body: {read}");

    let sections = h
        .run_tool(
            "chat",
            "academic_manuscript",
            &serde_json::json!({"action": "list", "project_id": project_id}).to_string(),
        )
        .expect("manuscript list");
    assert!(sections.contains("3 方法"), "list missing section: {sections}");
}

#[test]
fn evidence_records_dataset_and_experiment() {
    let h = TestHarness::new("agent-academic-evidence");
    let project_id = h.create_research_project("证据测试项目");

    let datasets = h
        .run_tool(
            "chat",
            "academic_evidence",
            &serde_json::json!({"action": "dataset_list", "project_id": project_id}).to_string(),
        )
        .expect("dataset list");
    assert!(datasets.contains("还没有数据集"), "unexpected: {datasets}");

    h.run_tool(
        "chat",
        "academic_evidence",
        &serde_json::json!({
            "action": "experiment_add",
            "project_id": project_id,
            "name": "baseline-run",
            "metrics_json": "{\"accuracy\":0.87}",
            "status": "done",
            "conclusion": "基线可用",
        })
        .to_string(),
    )
    .expect("experiment add");

    let runs = h
        .run_tool(
            "chat",
            "academic_evidence",
            &serde_json::json!({"action": "experiment_list", "project_id": project_id}).to_string(),
        )
        .expect("experiment list");
    assert!(runs.contains("baseline-run"), "missing experiment: {runs}");
    assert!(runs.contains("0.87"), "missing metrics: {runs}");
}

#[test]
fn literature_verify_reports_missing_ref_without_network() {
    let h = TestHarness::new("agent-academic-verify");
    let project_id = h.create_research_project("核验测试项目");
    let err = h
        .run_tool(
            "chat",
            "academic_literature",
            &serde_json::json!({
                "action": "verify",
                "project_id": project_id,
                "ref_id": "no-such-ref",
            })
            .to_string(),
        )
        .expect_err("missing ref must fail");
    assert!(err.contains("文献不存在"), "unexpected: {err}");
}

#[test]
fn dataset_import_and_analysis_validate_inputs() {
    let h = TestHarness::new("agent-academic-dataset-errors");
    let project_id = h.create_research_project("数据工具测试项目");

    let missing = h
        .run_tool(
            "chat",
            "academic_evidence",
            &serde_json::json!({
                "action": "dataset_import",
                "project_id": project_id,
                "path": "Z:/no-such-file.csv",
            })
            .to_string(),
        )
        .expect_err("missing data file must fail");
    assert!(missing.contains("源文件不存在"), "unexpected: {missing}");

    let empty_script = h
        .run_tool(
            "chat",
            "academic_evidence",
            &serde_json::json!({
                "action": "analysis_run",
                "project_id": project_id,
                "script": "   ",
            })
            .to_string(),
        )
        .expect_err("empty script must fail");
    assert!(empty_script.contains("分析脚本内容不能为空"), "unexpected: {empty_script}");
}

#[test]
fn literature_download_reports_missing_ref_without_network() {
    let h = TestHarness::new("agent-academic-pdf");
    let project_id = h.create_research_project("PDF 测试项目");
    let err = h
        .run_tool(
            "chat",
            "academic_literature",
            &serde_json::json!({
                "action": "download",
                "project_id": project_id,
                "ref_id": "no-such-ref",
            })
            .to_string(),
        )
        .expect_err("missing ref must fail");
    assert!(err.contains("文献不存在"), "unexpected: {err}");
}
