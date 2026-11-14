# 学术研究：复用通用 Agent 架构

> 目标：不新增独立 academic agent；学术能力作为主 Agent + DAG 计划器可调用的 capability pack。

## 1. 入口

- 唯一智能入口：`main` agent（不再注册 `academic` 子 agent）。
- 学术工具全局注册：
  - `academic_project`
  - `academic_literature`
  - `academic_manuscript`
  - `academic_evidence`
  - `research_workspace`
  - `run_code`
- 复杂科研任务由 `plan_and_run` 生成 DAG；DAG 节点可把上述工具作为 allowedTools。

## 2. 云盘空间

`research_workspace` 管理：

```text
学术研究空间
└── 论文题目 / 课题
    ├── 00_课题与计划
    ├── 01_文献
    ├── 02_数据
    ├── 03_代码与实验
    ├── 04_结果
    ├── 05_论文
    └── 06_投稿
```

- 文件夹由 app-cloud 持有（`/internal/cloud/folders`，apikey + uid）；
- app-ts 的 `research_workspaces` 集合只保存 workspace/project → folder_id 映射；
- 文件本体仍在云盘，不进入 MongoDB。

## 3. 使用顺序

```text
academic_project(action=create)
→ research_workspace(action=ensure_project, projectId, title)
→ 上传文件到 02_数据
→ academic_evidence(add_dataset / record_run)
→ academic_manuscript(create/save sections)
→ academic_manuscript(export)
```

## 4. 后台实验

仅支持 CS / SE / AI 类实验：训练、代码执行、数据分析；地质/物理/材料/生物等湿实验只能做方案与文档辅助。

- `academic_experiment(action=submit)` 持久化一条 `research_experiments` 记录并立即返回；
- 后台 `ResearchExperimentRunner` 调 app-sandbox 执行，不阻塞聊天；
- 结束/异常/中断后：
  - 更新实验终态；
  - 调用 callback，在同一 chat session 启动一次 main agent 回合（合成“实验回调”消息，读取 evidence 继续分析）；
  - 不要求模型轮询；
- app-ts 重启时，`queued/running` 记录标记为 `interrupted` 并触发回调；
- `academic_experiment(action=get/list)` 可供 AI 定时兜底查询。

## 4.2 文件 M2M 与结果回写

app-cloud 新增：

```http
POST /internal/cloud/files?uid=&folder_id=&name=&mime_type=  # 原始字节上传
GET  /internal/cloud/files?uid=&folder_id=                   # 列表
GET  /internal/cloud/files/:upload_uuid?uid=                 # 下载
```

- app-ts 的 `research_workspace` 支持 `upload_text` / `list_files`；
- 后台实验结束后 `ResearchExperimentRunner` 自动把 stdout.log / stderr.log / experiment.json 上传到 `04_结果` 并写入 evidence；
- `academic_validation` 检查引用是否 verified、结果章节是否带 `[[run:<id>]]`、成功 run 是否有脚本 hash；
- `plan_and_run` 支持 `template=research_paper`：自动生成选题/文献/设计/实验/分析/写作/审查 DAG。

## 4.1 当前边界（2026-11-12）

已具备：

- 主 Agent 直接使用学术工具；
- 学术空间/课题目录树（app-cloud 内部文件 folders/files 上传/下载/列表/删除已落地）；
- 论文/文献/证据工具；
- 后台实验（app-sandbox）与结果归档、结果表生成（`academic_analysis`）、引用/证据/可复现校验（`academic_validation`）；
- `plan_and_run` 的 `research_paper` DAG 模板 + 人工审批 gate（`research_approval`，UI 审批 Tab 可批准/拒绝）；
- 科研工作台 UI 覆盖：项目/阶段、文献、写作、实验、证据、校验、分析、空间、计划、审批、动态（契约见 [research-ui-api.md](research-ui-api.md)）。

仍待实现：

- 图表/结果图自动写入论文；
- 湿实验（非 CS/SE/AI）的方案辅助；
- 命令安全策略（allow/deny/审批）与更细粒度的沙箱配额策略。


## 5. 存储生命周期

| 目录 | 生命周期 |
|---|---|
| `00_课题与计划` / `01_文献` / `05_论文` / `06_投稿` | 永久 |
| `02_数据` / `03_代码与实验` / `04_结果` | 临时，按 `academic.retentionTempDays` 清理 |

- 默认 `retentionTempDays: 180`，每 6h 扫描一次；
- 只删除临时目录中超过保留期的文件；
- 论文、文献、计划、投稿目录永不自动删除；
- 删除走 app-cloud `DELETE /internal/cloud/files/:upload_uuid`。

## 6. 人工审批 gate

- AI 的 `research_approval(action=request)` 只能创建 pending；
- 审批通过/拒绝只能走用户 REST：
  `POST /academic/approvals/:id/decision`（X-Uid 鉴权）；
- `academic_experiment(submit)` 在没有 approved `experiment` 审批时直接拒绝，AI 不能自行批准；
- `submission` 审批预留给论文导出/提交。


## 7. 实验批次归档

实验产物文件名：

```text
{YYYY-MM-DD}__{experimentId}__stdout.log
{YYYY-MM-DD}__{experimentId}__stderr.log
{YYYY-MM-DD}__{experimentId}__experiment.json
```

- 同一天同一项目的实验结果按 `日期 + experimentId` 归档，不会互相覆盖；
- 清理器按文件 `created_at` 和 `academic.retentionTempDays` 删除临时实验数据；
- 论文/文献/计划/投稿目录永久保留。
