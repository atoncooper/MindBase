# VS Code 配置说明（多语言单仓）

本仓同时包含 TS/Node（`frontendv2` / `app-ts` / `frontend-admin`）、Go（`app-go/*`、`mcp/*`、
`app-board`）、Java（`app-pay`）与脚本工程。

> 桌面端（Tauri 2 + Rust）已拆分为独立仓库 [atoncooper/mind-base-desktop](https://github.com/atoncooper/mind-base-desktop)，
> 本仓不再包含 Rust 工程，相关 rust-analyzer / cargo 任务配置随源码一并迁出。

## 1. 为什么每次打开都在跑 Java 构建

根目录工作区里存在 `app-pay/pom.xml`，旧的 `.vscode/settings.json` 配了
`java.jdt.ls.java.home`、`maven.executable.path` 等；Java 扩展一旦激活就会扫描并
**自动 import + 构建 Maven 工程**，于是每次打开 VS Code 都跑 Maven。

现在根工作区已关闭（设置仅本地生效，`.vscode/` 在 `.gitignore` 中）：

```jsonc
"java.import.maven.enabled": false,
"java.import.gradle.enabled": false,
"java.autobuild.enabled": false,
"java.configuration.updateBuildConfiguration": "disabled",
```

JDK / Maven 路径保留，供 Java 专用工作区使用。

## 2. 日常用法

| 场景 | 做法 |
|---|---|
| 默认（前后端 / Go 日常开发） | 直接打开仓库根目录；Java 不自动构建 |
| 改 Java（app-pay） | `code .vscode/app-pay.code-workspace`（只把 app-pay 作为根，Java import 重新开启） |
| 前端 | `cd frontendv2 && npm run dev`；管理台 `cd frontend-admin && pnpm dev` |
| AI 域 | `cd app-ts && npm run dev` |
| Go 服务 | 每个服务是独立 module：`cd app-go/app-note && go run .` |
| 测试 | 见 [project-structure.md](project-structure.md)「测试矩阵」 |

## 3. 其他优化

- `cmake.configureOnOpen: false`：仓内没有 CMake 工程（历史原生目标已移除），保留该开关只为阻止扩展扫描与无谓配置。
- `files.watcherExclude` / `search.exclude` / `files.exclude`：排除 `node_modules`、`dist`、`.next`、`target`、
  `logs`、`data`，减少启动抖动与搜索噪音。
- `.vscode/` 被 `.gitignore` 忽略，这些设置**本地生效、不随仓库分发**；若希望团队共享，需把
  `.vscode/` 从 `.gitignore` 移除后提交。
