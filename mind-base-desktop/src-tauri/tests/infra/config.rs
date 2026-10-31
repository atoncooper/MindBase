//! infra::config：默认关闭命令执行、开关可持久化读取。

use mind_base_desktop_lib::TestHarness;

#[test]
fn shell_execution_is_disabled_by_default() {
    let h = TestHarness::new("infra-config-default");
    assert!(!h.shell_enabled(), "shell_enabled must default to false");
}

#[test]
fn shell_switch_round_trips_through_config_store() {
    let h = TestHarness::new("infra-config-toggle");
    h.set_shell_enabled(true);
    assert!(h.shell_enabled());
    h.set_shell_enabled(false);
    assert!(!h.shell_enabled());
}
