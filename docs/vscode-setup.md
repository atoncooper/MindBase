# VS Code 配置说明（多语言单仓）

本仓同时包含 Rust（`mind-base-desktop/src-tauri`）、TS/Node（`frontendv2` / `app-ts` /
`mind-base-desktop/src`）、Go（`app-go/*`、`mcp/*`）、Java（`app-pay`）、CMake（`app-mobile`）。
VS Code 默认工作区只按「桌面端 Rust + 前端」优化，避免打开仓库就触发无关语言的构建。

## 1. 为什么每次启动都在跑 Java 构建

根目录工作区里存在 `app-pay/pom.xml`，而旧的 `.vscode/settings.json` 配了
`java.jdt.ls.java.home`、`maven.executable.path` 等；Java 扩展一旦激活就会扫描并
**自动 import + 构建 Maven 工程**，于是每次打开 VS Code 都跑 Maven。

现在根工作区已关闭：

```jsonc
"java.import.maven.enabled": false,
"java.import.gradle.enabled": false,
"java.autobuild.enabled": false,
"java.configuration.updateBuildConfiguration": "disabled",
```

JDK / Maven 路径保留（给 Java 专用工作区用）。

## 2. 为什么 Rust 插件「用不上」

rust-analyzer 默认只在**工作区根目录**找 `Cargo.toml`；本仓根目录没有（Rust 工程在
`mind-base-desktop/src-tauri`，且它本身是含 `tests/` 成员的 Cargo workspace）。
因此分析器一直没有 linked project，表现为无补全 / 一直 Loading / 报
"No Cargo.toml found"。

修复（已写入 `.vscode/settings.json`）：

```jsonc
"rust-analyzer.linkedProjects": ["mind-base-desktop/src-tauri/Cargo.toml"],
"rust-analyzer.check.command": "check",
"rust-analyzer.check.extraArgs": ["--workspace"],
```

> 若仍不生效：确认已安装扩展 `rust-lang.rust-analyzer`（打开仓库时会提示安装）；
> 确认窗口不是 **Restricted Mode**（受限模式不会启动语言服务器，点信任即可）；
> 然后执行命令面板 → “rust-analyzer: Restart Server”。

> 注意：仓库根 `.gitignore` 第 36 行忽略了 `.vscode/`，所以这些设置是**本地生效**、不会随
> 仓库分发；若希望团队共享，需要把 `.vscode/` 从 `.gitignore` 移除后提交。

## 3. 日常用法

| 场景 | 做法 |
|---|---|
| 默认（Rust + 前端） | 直接打开仓库根目录 |
| 改 Java（app-pay） | `code .vscode/app-pay.code-workspace`（只把 app-pay 作为根，Java import 重新开启） |
| 构建 | `Ctrl+Shift+B` → `rust: cargo check (workspace)` |
| 测试 | 任务 `rust: cargo test`，或终端 `cargo test` |
| 桌面端联调 | 任务 `desktop: tauri dev` |

## 4. 其他优化

- `cmake.configureOnOpen: false`：打开仓库不再自动配置 `app-mobile/windows`；
- `files.watcherExclude` / `search.exclude` / `files.exclude`：排除
  `target`、`node_modules`、`dist`、`.next`、`logs`、`data`，减少启动抖动与搜索噪音；
- `.vscode/extensions.json`：只推荐 Rust/桌面端扩展；
- `.vscode/tasks.json`：cargo check/test、npm build、tauri dev 任务。
