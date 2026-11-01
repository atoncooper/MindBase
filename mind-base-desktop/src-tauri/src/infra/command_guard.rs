//! 危险命令黑名单：内置 JSON 规则 + 用户在数据目录里的运行期覆盖。
//!
//! 规则文件格式（<data_dir>/command-blocklist.json）：
//!
//! {"version": 1, "patterns": [
//!   {"match": "rm -rf /", "reason": "递归删除根目录"},
//!   {"match": "mkfs", "token": true, "reason": "格式化文件系统"}
//! ]}
//!
//! 匹配规则（与 JSON 里的 pattern 一一对应）：
//! - 命令先 trim、转小写、连续空白归一化；
//! - 含空格的 pattern 做子串匹配（例如 "rm -rf /" 命中 "sudo rm -rf /"）；
//! - token=true 的 pattern 按空白 / 分号 / && / || / | / 括号切分成 token 后做
//!   整词匹配（mkfs.ext4 也算命中 mkfs）；
//! - 其余（不含空格、非 token）pattern 做子串匹配（如 ":(){"）。
//!
//! 强制点：run_command / run_sandboxed 工具在 spawn 前调用 check()，
//! 自动化任务在 supervisor::start spawn 前调用 check()；remote_exec 在执行
//! 远程命令前调用 check()。命中即返回中文错误，命令不会被执行。
//!
//! 内置规则用 include_str! 编进二进制；若数据目录存在同名 JSON 则优先使用，
//! 解析失败时 eprintln 告警并回退内置规则（桌面端不能因为一份坏配置就失效）。
//! 规则按「数据目录 + 文件 mtime/长度」缓存，用户改完 JSON 无需重启。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Deserialize;

/// 内置黑名单（编译进二进制，始终可用）。
const DEFAULT_BLOCKLIST: &str = include_str!("../../resources/command-blocklist.json");

/// 数据目录里的覆盖文件名。
const OVERRIDE_FILE: &str = "command-blocklist.json";

/// 缓存条目上限：正常只有 1 个数据目录，测试会用到多个临时目录。
const MAX_CACHE_ENTRIES: usize = 8;

#[derive(Debug, Deserialize)]
struct RawBlocklist {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    patterns: Vec<RawPattern>,
}

#[derive(Debug, Deserialize)]
struct RawPattern {
    #[serde(rename = "match")]
    pattern: String,
    #[serde(default)]
    reason: String,
    /// 按 token 整词匹配（用于 shutdown / mkfs 这类单词规则）。
    #[serde(default)]
    token: bool,
}

/// 解析后的单条规则。
#[derive(Debug, Clone)]
struct Rule {
    needle: String,
    reason: String,
    token: bool,
}

/// 一套生效规则。
#[derive(Debug, Clone, Default)]
pub(crate) struct RuleSet {
    #[allow(dead_code)] // 仅用于排查/测试：记录生效文件的版本号
    version: u32,
    rules: Vec<Rule>,
}

#[derive(Debug, Clone)]
struct CacheEntry {
    data_dir: PathBuf,
    /// 覆盖文件的 (mtime_nanos, len)；None = 文件不存在（使用内置规则）。
    signature: Option<(u64, u64)>,
    rules: Arc<RuleSet>,
}

static CACHE: Mutex<Vec<CacheEntry>> = Mutex::new(Vec::new());

/// 归一化：去首尾空白 -> 转小写 -> 连续空白压成一个空格。
fn normalize(text: &str) -> String {
    text.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// 按 shell 分隔符切 token：空白、分号、&、|、括号、反引号。
fn for_each_token(normalized: &str, mut f: impl FnMut(&str) -> bool) -> bool {
    for token in normalized.split(|c: char| {
        c.is_whitespace() || matches!(c, ';' | '&' | '|' | '(' | ')' | '\u{0060}')
    }) {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        if f(token) {
            return true;
        }
    }
    false
}

/// 单个 token 是否命中单词类规则：整词相等，或带路径（/sbin/fdisk）、
/// 或同类工具后缀（mkfs.ext4 / mkfs.xfs）。
fn token_matches(token: &str, needle: &str) -> bool {
    if token == needle {
        return true;
    }
    let base = token.rsplit('/').next().unwrap_or(token);
    if base == needle {
        return true;
    }
    base.strip_prefix(needle)
        .map(|rest| rest.starts_with('.'))
        .unwrap_or(false)
}

fn parse_rules(text: &str) -> Result<RuleSet, String> {
    let raw: RawBlocklist =
        serde_json::from_str(text).map_err(|err| format!("黑名单 JSON 解析失败：{err}"))?;
    let mut rules = Vec::new();
    for entry in raw.patterns {
        let needle = normalize(&entry.pattern);
        if needle.is_empty() {
            continue;
        }
        let reason = entry.reason.trim();
        let reason = if reason.is_empty() {
            format!("命中危险命令规则 {}", entry.pattern)
        } else {
            reason.to_string()
        };
        rules.push(Rule {
            needle,
            reason,
            token: entry.token,
        });
    }
    Ok(RuleSet {
        version: raw.version,
        rules,
    })
}

/// 覆盖文件的签名；文件不存在 / 不是普通文件 -> None。
fn file_signature(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_nanos() as u64)
        .unwrap_or_default();
    Some((mtime, meta.len()))
}

fn load_rules(override_path: &Path, override_exists: bool) -> RuleSet {
    if override_exists {
        match std::fs::read_to_string(override_path) {
            Ok(text) => match parse_rules(&text) {
                Ok(rules) if !rules.rules.is_empty() => return rules,
                Ok(_) => eprintln!(
                    "[command-guard] {} 未定义任何规则；回退内置黑名单",
                    override_path.display()
                ),
                Err(err) => eprintln!(
                    "[command-guard] {} 解析失败（{err}）；回退内置黑名单",
                    override_path.display()
                ),
            },
            Err(err) => eprintln!(
                "[command-guard] 读取 {} 失败（{err}）；回退内置黑名单",
                override_path.display()
            ),
        }
    }
    parse_rules(DEFAULT_BLOCKLIST).expect("内置危险命令黑名单 JSON 必须可解析")
}

/// 取当前生效规则（带缓存；覆盖文件改动后自动失效重载）。
fn rules_for(data_dir: &Path) -> Arc<RuleSet> {
    let override_path = data_dir.join(OVERRIDE_FILE);
    let signature = file_signature(&override_path);
    if let Ok(cache) = CACHE.lock() {
        if let Some(entry) = cache
            .iter()
            .find(|entry| entry.data_dir == data_dir && entry.signature == signature)
        {
            return entry.rules.clone();
        }
    }
    let rules = Arc::new(load_rules(&override_path, signature.is_some()));
    if let Ok(mut cache) = CACHE.lock() {
        cache.retain(|entry| entry.data_dir != data_dir);
        cache.push(CacheEntry {
            data_dir: data_dir.to_path_buf(),
            signature,
            rules: rules.clone(),
        });
        while cache.len() > MAX_CACHE_ENTRIES {
            cache.remove(0);
        }
    }
    rules
}

/// 校验一条命令是否命中危险命令黑名单。
///
/// 命中返回可直接展示给用户的中文错误（含原因与处理建议）；放行返回 Ok(())。
/// 空命令视为放行（调用方自己会拒绝空命令）。
pub fn check(data_dir: &Path, command: &str) -> Result<(), String> {
    let normalized = normalize(command);
    if normalized.is_empty() {
        return Ok(());
    }
    let rules = rules_for(data_dir);
    for rule in &rules.rules {
        let hit = if rule.token {
            for_each_token(&normalized, |token| token_matches(token, &rule.needle))
        } else {
            normalized.contains(&rule.needle)
        };
        if hit {
            return Err(format!(
                "命令被危险命令黑名单拒绝：{}。\n该命令可能造成不可恢复的破坏，已被拦截（规则来自内置黑名单或 <data_dir>/command-blocklist.json）。如确需执行，请在目标机器上手动操作，或由管理员调整黑名单后重试。",
                rule.reason
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mindbase-cmdguard-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|delta| delta.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn builtin_rules_are_parsable_and_non_empty() {
        let rules = parse_rules(DEFAULT_BLOCKLIST).expect("default blocklist parses");
        assert_eq!(rules.version, 1);
        assert!(rules.rules.len() >= 15, "内置规则过少：{}", rules.rules.len());
        assert!(rules.rules.iter().all(|rule| !rule.reason.is_empty()));
    }

    #[test]
    fn catastrophic_commands_are_blocked() {
        let dir = temp_dir("blocked");
        let cases = [
            "rm -rf /",
            "rm -rf /*",
            "sudo rm -rf /",
            "RM -FR /",
            "rm -r -f /",
            "rm -rf --no-preserve-root /",
            "mkfs /dev/sdb1",
            "sudo mkfs.ext4 /dev/sdb1",
            "wipefs -a /dev/sdb",
            "fdisk /dev/sda",
            "parted /dev/sda",
            "dd if=/dev/zero of=/dev/sda",
            ":(){ :|:& };:",
            "shutdown -h now",
            "reboot",
            "poweroff",
            "halt",
            "chmod -R 777 /",
            "chown -R /etc",
            "mv /* /tmp",
            "echo hacked > /dev/sda",
            "crontab -r",
        ];
        for command in cases {
            let err = check(&dir, command).expect_err(&format!("命令应被拦截：{command}"));
            assert!(err.contains("危险命令黑名单"), "{command}: {err}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normal_commands_pass() {
        let dir = temp_dir("pass");
        for command in [
            "ls -la",
            "cargo test --lib",
            "git status",
            "rm -rf build",
            "rm -rf ./target",
            "mkdir -p /opt/app",
            "cd /srv && ls",
            "echo hello > /tmp/report.txt",
            "",
        ] {
            assert!(check(&dir, command).is_ok(), "命令不应被拦截：{command:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalization_handles_case_and_whitespace() {
        let dir = temp_dir("normalize");
        let weird = "   SuDo   RM   -RF    /   ";
        assert!(check(&dir, weird).is_err(), "大小写/空白归一化后应命中");
        assert!(check(&dir, "SHUTDOWN  -H  NOW").is_err());
        // 子串匹配：前后带其它命令仍命中。
        assert!(check(&dir, "echo start && rm -rf /").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn token_rules_only_match_whole_words() {
        let dir = temp_dir("token");
        // 整词命中
        assert!(check(&dir, "echo reboot").is_err());
        assert!(check(&dir, "sudo -i shutdown -r now").is_err());
        // 不是整词：不应命中
        assert!(check(&dir, "echo reboots").is_ok());
        assert!(check(&dir, "echo shutdown_now").is_ok());
        assert!(check(&dir, "echo my-reboot-script").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn runtime_override_replaces_builtin_rules_and_reloads() {
        let dir = temp_dir("override");
        let path = dir.join(OVERRIDE_FILE);
        std::fs::write(
            &path,
            r#"{"version": 9, "patterns": [{"match": "echo forbidden", "reason": "自定义测试规则"}]}"#,
        )
        .expect("write override");
        let err = check(&dir, "echo forbidden").expect_err("自定义规则应命中");
        assert!(err.contains("自定义测试规则"), "原因未透传：{err}");
        // 覆盖文件生效时，内置规则不再生效。
        assert!(check(&dir, "rm -rf /").is_ok(), "覆盖应替换内置规则");

        // 改小文件长度以改变签名，验证缓存失效。
        std::fs::write(
            &path,
            r#"{"version": 10, "patterns": [{"match": "echo nope", "reason": "第二条规则"}]}"#,
        )
        .expect("rewrite override");
        assert!(check(&dir, "echo nope").is_err(), "缓存未失效");
        assert!(check(&dir, "echo forbidden").is_ok(), "旧规则仍生效");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_override_falls_back_to_builtin_rules() {
        let dir = temp_dir("invalid");
        std::fs::write(dir.join(OVERRIDE_FILE), "not-a-json").expect("write bad override");
        let err = check(&dir, "rm -rf /").expect_err("坏配置应回退内置规则");
        assert!(err.contains("危险命令黑名单"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
