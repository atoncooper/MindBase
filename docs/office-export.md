# Office 能力（导出 / 读取 / 视觉复核）

> 面向 agent 的 Office 三件套能力：生成 docx/xlsx/pptx 并保存到用户云盘 agent/ 目录；
> 读取用户已有 Office 文件的结构；在模型看不到文件本身时，把文件渲染成图片交给视觉模型逐页看、
> 再让 agent 按意见修改重生成。
>
> 实现位置：app-ts/src/services/office/（生成）、src/services/office-render/（渲染 + 视觉）、
> src/services/office-review.ts（读取/复核编排）、src/services/cloud-folders.ts（目标目录解析）、
> src/tools/office/（三个 agent 工具）。学术稿件 Word 导出是另一条链路（docs/manuscript-docx.md）。

## 零、生成架构（2026-11 重构）

Word 生成拆成四层，内容与视觉解耦：

1. **Content Engine**（src/services/office/content-engine.ts）：plan 大纲 → sections 逐章 IR → edit 整篇去套话/去重/补事实/统一语气 → 质量修复循环；写作策略按 8 种体裁写在 prompts/office/*.md，LLM 经 TextGenerationPort 注入。
2. **Document IR + Template Registry**（ir.ts / templates.ts）：IR 表达 section/title/heading/paragraph/line/list/table/image/caption/quote/codeBlock/formula/reference/toc/pageBreak/sectionBreak/callout/kv/metrics；8 套模板（academic / business-plan / work-report / research-report / meeting-minutes / tech-design / resume / notice）各自定义页面、字体字号、标题层级、行距缩进、页眉页脚页码、表格样式、编号与目录；优先级 = 用户 .docx 模板 > 指定模板 > 关键词推断 > 默认 work-report。
3. **DOCX Renderer**（render-doc.ts + style-system.ts）：原生样式表、多节页面设置（含横向节）、页眉页脚 + PAGE/NUMPAGES 域、TOC 域（updateFields）、原生编号、重复表头表格、内联图片（PNG/JPEG 尺寸解析 + 图注）、代码块、公式、分页/分节；用户模板模式只替换 document.xml，保留其样式与页面设置。
4. **Render & QA**（src/services/office/qa.ts + scripts/office-qa.ts；CI/评测镜像内跑 LibreOffice）：DOCX→PDF → pdfinfo / pdftotext -bbox / pdftohtml / pdfimages / pdftoppm → 文本越界、空白页、页眉页脚、标题层级、字体、目录、图片、页面尺寸检查，可选视觉复核，输出中文报告（npm run qa:office）；缺 LibreOffice/poppler 时明确不可用，不伪造结果。

工具兼容：office_export 新增 docx.document（IR）与 docx.template（8 套模板）；旧 docx.blocks/layout 自动转 IR，向后兼容。

示例：npm run samples:office 生成 4 份真实文档到 app-ts/qa-output/（10 页调研报告、含图表与复杂表格的商业方案、含目录页眉页脚的技术设计、学术报告），已用 Word/LibreOffice 渲染检查。

## 一、能力矩阵


| 能力 | 工具 | 依赖 | 说明 |
|------|------|------|------|
| 生成 Word/Excel/PPT | office_export | 无（纯 JS 手写 OOXML） | 落盘到云盘 agent/；可指定子目录或文件夹 id |
| 读取结构（docx/xlsx/pptx） | office_inspect | 无 | 标题层级/表格合并/工作表与公式/每页标题与形状 |
| 版面视觉复核 | office_visual_check | LibreOffice + poppler + 视觉模型 | 逐页渲染成 PNG，视觉模型给「第几页怎么改」 |
| 文本理解（模型直读） | cloud_file_read / 会话上传解析 | 无 | 云盘管道已抽纯文本，供 RAG/对话直接使用 |

模型能力分支（同一份文件，按模型能力选最省的一条）：

1. **模型能直接吃文件**（多模态文档输入，如 PDF/图片）：直接把原始文件或渲染后的页面作为输入，模型自己看；
2. **模型只能看图**：office_visual_check 负责渲染 + 调用视觉模型评审，把结论文本回灌 ReAct 循环；
3. **模型只能吃文本**：office_inspect / cloud_file_read 返回结构化文本，够用时不必渲染。

当前实现落地的是 1（会话已支持图片输入 + 云盘文本抽取）、2、3；完整「把 ppt 原文件作为用户消息附件直传聊天主模型」
仍受 agent 循环的多模态工具结果限制（见末节）。

## 二、office_export：生成并落盘

一次调用只生成一种格式；format 决定必填分支。

Word：

Word 版式系统（模板 + 模块，2026-11）：
- docx.layout 四套模板：report（报告/复盘，默认）/ proposal（方案计划）/ resume（简历，紧凑字号+窄边距）/
  brief（通知简报，一页内）；docx.margins 可选 normal/narrow/wide 覆盖页边距。
- 模块 blocks：cover（封面页：主标题/副标题/信息行，自动分页且首页不显示页码）、heading(1-3)、paragraph、
  line（无缩进信息行）、bullets(ordered)、quote、table（表头 + caption 表题，列宽按内容自动估算）、
  kv（label/value 信息网格，无边框仅行分隔）、metrics（2-4 个关键数字卡片）、
  callout（结论/风险/提示，tone=info/warning/success）、divider、pageBreak。
- 主题负责页边距、正文字号/行距/首行缩进、标题层级（H1 带细分隔线）、表格/表题/模块样式、
  页脚「第 X 页 / 共 Y 页」；templateUploadUuid 模板模式沿用用户 .docx 的样式/页眉页脚/页面设置。
- 工具描述内置写作规范（正式书面语、禁 AI 腔套话、数据进表格/指标卡、简历用 line+kv+bullets、不留占位符）；
  模型只选模板 + 填模块，不再用空行/空格凑版式。
- 视觉基线经 LibreOffice 144dpi 渲染校验；注意 LibreOffice 对 w:val=nil 边框会画默认线，
  无边框模块改用白色 hairline 边框（白色页面上不可见）。

## 三、office_inspect：读取已有文件的结构

输入：sessionDocument（本会话上传的文件名/文档 id）或 uploadUuid（云盘文件），二选一；可给 maxChars / maxRows。

- Word：页边距/分节、字体字号与段落样式、表格合并与底纹、页眉页脚、文档属性（复用 docx-detail 解析器）；
- Excel：工作表清单、行列规模、表头与前 N 行、公式清单、合并单元格、冻结窗格、筛选、列宽；
- PPT：页序、每页标题与文字、表格、形状/图片数量、是否含图表、页面尺寸。

纯函数解析（jszip），不依赖任何二进制；每次都有解压体积与条目上限，超限给出明确错误。

## 四、office_visual_check：渲染 + 视觉评审

流程：源文件 → Gotenberg（或本机 soffice）转 PDF → PDFium（npm）逐页 PNG（默认 6 页，一次最多 8 页）→ 均匀抽样最多 6 张 →
视觉模型按「文字溢出/截断/重叠、对齐留白、表格列宽、图片变形、页眉页脚与页码一致性」输出逐页可执行建议。

用途：

1. 用户上传 ppt/docx/xlsx 要求评价排版；
2. agent 自己 office_export 出文件后自检，再按意见改内容重生成（生成 → 看 → 改 的闭环）。

降级路径（全部返回中文说明而不是抛错）：

- 渲染器不可用（镜像没装 LibreOffice/poppler）→ 提示用 office_inspect 看结构文本；
- 未配置视觉模型 → 说明已渲染 N 页但无法评审；
- 转 PDF / 转图片失败或超时 → 带原始错误摘要；
- 文件超上限 → 建议改用结构文本。

## 五、前端展示：聊天不预览，云盘全屏原生渲染 + AI 侧栏

分工：**聊天只给文件下载卡片，Word 版式在云盘详情查看**；云盘详情铺满全屏原生渲染，AI 摘要/检索走右侧抽屉。

- 聊天：office_export 不再下发 office-document artifact（历史消息里该 kind 直接隐藏）；
  对话里只有可下载的文件卡片（下载 / 在云盘打开 / 复制链接）。
- 云盘详情（/cloud-drive/<uuid>）：打开即**自动原生渲染**，无需点击；
  依赖 `docx-preview@0.4`（frontendv2，纯浏览器端）——artifact uploadUuid → `cloudApi.getRawFile`
  取云盘原文件 presigned URL（同源 /minio-proxy）→ fetch ArrayBuffer → renderAsync；
  组件 `components/cloud-drive/file-document-preview.tsx` + `components/chat/artifacts/native-docx-viewer.tsx`
  （fill 模式占满视口、纸张页宽度自适应、内部滚动；渲染后移除 script/iframe/form、过滤 javascript: 链接）。
- 全屏：file-viewer 内容区改为 h-full 全宽（图片/PDF/视频/文本/docx 各自铺满），不再用 960px 居中列。
- AI 侧栏：标题栏「AI 摘要」按钮打开右侧抽屉（遮罩 + 滑入 + Esc/遮罩关闭 + 焦点管理，role=dialog），
  内容为 FileAiPanel（摘要/相似文件/问这份文件）；原先内容下方的内联 AI 面板已移除。
- 回退：若原始文件取不到（权限/存储异常），自动回退 `GET /chat/office/document` 的结构化 blocks 预览；
  404/503 有明确提示与重试；非 docx 仍显示「不支持在线查看 + 下载」。
- 网关：`/chat/office/document` 在 APISIX `chat_ts` uris 中（旧 `/chat/office/preview` 已删除），改完需重载 APISIX。

## 六、落盘位置：云盘 agent/ 目录

| 关注点 | 约定 |
|--------|------|
| 默认目录 | 用户云盘根下的 agent/（注册时由 app-user 调 app-cloud M2M 创建） |
| 缺失时 | app-ts 首次导出自动补建（find-or-create，大小写不敏感匹配；并发同路径只解析一次，创建撞车时重列复用） |
| 子目录 | folderPath（agent/ 下最多 6 层，如 2026Q3/周报）；每层缺失自动创建 |
| 指定文件夹 | folderId 直接指定已有云盘文件夹（优先于 folderPath） |
| 缓存 | folderId 按 uid+路径缓存（默认 10 分钟），避免每次导出都列云盘目录 |
| 存储 | app-cloud M2M POST /internal/cloud/files（apikey + X-Uid）；只有云盘持有 MinIO 凭证 |
| 大小上限 | officeExport.maxBytes（默认 24MB） |
| 额度 | quota.kindTokenCost.office_export = 1500 标准 token（共享 token 池；quota.enabled=false 时只记账） |

旧版 app-cloud 兼容：若 `GET /internal/cloud/folders` 返回 404（镜像未升级），导出不会失败——
文件自动写到云盘**根目录**，结果里标注「agent/ 目录接口未就绪：请重新构建并重启 app-cloud」；
升级 app-cloud 后自动恢复写入 agent/。

## 七、配置

    officeExport:
      rootFolder: agent          # 导出根目录（注册时创建；缺失自动补建）
      folderCacheTtlMs: 600000   # 目录 id 缓存
      maxBytes: 25165824         # 单个成品上限（24MB）

    officeRender:
      enabled: true              # 关闭则 visualCheck 直接说明不可用
      backend: http              # http = Gotenberg 侧车（默认部署）；soffice = 本机/自定义镜像
      http:
        url: http://gotenberg:3000
        endpoint: /forms/libreoffice/convert
        timeoutMs: 120000
      sofficePath: ""            # 仅 backend=soffice：LibreOffice 可执行文件
      pdftoppmPath: ""           # 仅 backend=soffice：poppler pdftoppm
      timeoutMs: 120000          # 单次渲染总预算
      maxPages: 16               # 硬页数上限
      defaultPages: 6            # 默认渲染页数
      dpi: 110                   # PNG 分辨率
      maxImages: 6               # 一次送视觉模型的最大张数
      visionModel: ""             # 空 = 复用 OCR__MODEL（默认 z-ai/glm-5.3-flash）

镜像（2026-11 精简后，纯 npm）：

- app-ts 镜像只含 Node 运行时与 npm 依赖，没有 apt、LibreOffice、poppler；健康检查用 node fetch，不再需要 wget。
- Office 转 PDF：由 Gotenberg 侧车完成（docker compose --profile office up -d gotenberg，
  compose 默认 OFFICERENDER__BACKEND=http 与 http://gotenberg:3000），业务镜像无需重建。
- PDF 转 PNG：@hyzyla/pdfium（PDFium WASM，MIT，零系统依赖），内置 PNG 编码，不需要 pdftoppm/poppler。
- 视觉回归 / golden：CI 的 office-eval workflow 内联构建评测镜像
  （Debian bookworm + LibreOffice 7.4 + poppler + Noto CJK），仓库不保留 Dockerfile，与业务镜像无关。
- 部署后自检：docker compose exec app-ts node -e "fetch('http://gotenberg:3000/health')"（Gotenberg 起时）。

## 八、验证

| 层 | 方式 |
|----|------|
| 单测 | test/office-export.test.ts（生成包结构、模板、尺寸、工具意图）；test/office-folders.test.ts（agent/ 创建/复用/嵌套/并发/错误映射、默认与显式目标目录）；test/office-render.test.ts（假 runner 跑通 soffice→PDF→PNG、页码选择、超时与失败映射、可用性探测）；test/pptx-detail.test.ts / test/xlsx-detail.test.ts（解析器）；test/office-review.test.ts（读取与视觉复核编排） |
| 版式/预览 | test/office-export.test.ts 的 docx layout 用例（cover/metrics/kv/callout 渲染、resume 主题、margins）+ test/office-document.test.ts（结构化回退契约/路由） |
| 类型 | npm run typecheck |
| 真实文件 | 生成后 LibreOffice 渲染逐页核对，并用 python-docx / python-pptx / openpyxl 打开校验；office_recalculate 验证公式 |
| 回归 | npm test 全量 |

## 九、已知边界与后续

- 云盘只有文本抽取，没有内置版面预览：生成结果需下载查看；视觉复核 + 页面预览卡片正是为了补这个盲区。
- Excel 公式不写缓存值：Excel/LibreOffice 打开时重算，公式单元格显示常规格式。
- 「把 ppt/docx 原文件作为用户消息附件直传聊天主模型」尚未接入 agent 循环的多模态工具结果；
  当前等价能力 = 云盘文本抽取（理解内容）+ 渲染后视觉复核（理解版面）+ 视觉模型评审（看图迭代）。
  接入方式：ToolOutput 增加多模态 parts 并让 runtime 把图片作为工具结果回传给模型（约 1 天）。
- 可选后续：PPT 模板套用（按用户 .pptx 版面替换内容）、Word 图片/目录域、Excel 图表、
  写作页/云盘「导出」直连 HTTP 路由。

## 镜像与渲染环境（2026-11 精简后）

- **app-ts 镜像只含 Node 运行时**：不装 LibreOffice/poppler，也不需要 apt（健康检查用 node fetch），构建快、镜像小。
- 需要“看版面”（office_visual_check、渲染 QA）时两种方式：
  1. **Gotenberg 侧车**：docker compose --profile office up -d gotenberg；compose 默认 OFFICERENDER__BACKEND=http + OFFICERENDER__HTTP__URL=http://gotenberg:3000，无需重建 app-ts。
  2. **评测/CI 环境**：office-eval workflow 内联构建（Debian + LibreOffice 7.4 + poppler + Noto CJK），用于 eval:office 与 golden 生成；仓库不保留 Dockerfile。
- 未配置渲染时 office_visual_check 明确降级（不影响生成）；结构/内容质检始终可用。
- 旧参数 APP_TS_WITH_OFFICE_RENDERER / app-ts/docker/office-base.Dockerfile 已移除。

## 文档迭代：同一文件多版本，不再重复新建（2026-11）

问题：agent 每次修改都调用 office_export 生成新文件，云盘里堆出多个带时间戳的副本，聊天卡片/链接也各自指向不同文件。

改造后：

- `office_export` 新增 `revisionOf` 参数（上次返回的 `uploadUuid`）。传了它 = **覆盖同一文件内容**：
  - app-cloud 新增 M2M `PUT /internal/cloud/files/:upload_uuid`（同 uuid 原地覆盖 MinIO 对象 + 更新元数据，
    重置 content_hash/vector 状态，避免旧向量继续命中）；
  - app-ts `OfficeExportService.replaceExisting()` 走 `replaceFile`，**不调用上传、不占用导出额度、不产生新文件名/时间戳**；
  - 返回的 `uploadUuid` 与之前一致，因此聊天里旧文件卡片、云盘链接、分享引用都会指向最新版本；
  - 结果文案明确写「已更新同一文件（覆盖原文件，未新建文件）」。
- 首次生成（没有 revisionOf）才走原来的上传，文件名带时间戳避免碰撞。
- 工具描述明确要求：用户要求修改/润色/调整此前文档时必须传 `revisionOf`；只有首次创建才新建文件。
- 兼容：app-cloud 未升级时 revision 会返回明确中文提示（“云盘服务不支持版本覆盖，可先删除旧文件再生成”），不会静默新建第二个文件。

限制：当前只保留**最新版本**（原地覆盖），不保留历史版本；如需版本历史应在 app-cloud 增加对象版本表（未实现）。

## 视觉设计升级（2026-11，参考业界实现）

调研了当前主流的 LLM Office 生成实现：

- **Microsoft entrabot《LLM-Driven Office Authoring V2》**：明确“把 Markdown 包一层 python-docx”会产出明显通用的文档；
  正确架构是 **模板库 + Document IR + 确定性渲染器**，并配套 golden 文件/渲染评测；
- **Anthropic docx skill**：TOC 必须依赖内置 Heading 样式（或 outlineLevel）；禁止手写项目符号；
  不要用表格当分隔线（用段落底边框）；生成后必须转 PDF 看图校验；
- **Office-Word-MCP-Server**：表格能力（表头高亮、隔行底色、单元格内边距、callout 表格）是“像人做的”关键；
- 共性：模板/命名样式/主题色/封面/页眉页脚/自动编号/图表题注/渲染质检缺一不可。

据此完成的设计升级（`render-doc.ts` / `style-system.ts`）：

1. **主题部件 theme1.xml**：颜色方案与字体方案跟模板走（标题黑体/正文宋体、accent 色），Word 样式库与主题色一致；
2. **真正的多级标题编号**：numbering.xml `numId=10` 多级列表绑定 Heading1/2/3 样式（中文 `一、/（一）/1.` 或 `1/1.1/1.1.1`），
   编号由 Word 生成、增删自动重排、TOC 自动带编号；模型误写的编号在渲染时剥离；
3. **封面重做**：顶部 accent 色带 + 单位/标题/副标题 + 细分隔线 + 底部作者/日期/文号区块，首页不显示页眉页脚；
4. **页眉双栏**：左侧文档标题、右侧单位/文号 + 发丝线；页脚「页码 / 共 N 页」，首页（封面）不编号；
5. **表格质感**：表头模板色、隔行浅底（≥4 行）、发丝边框、单元格内边距；
6. **题注自动编号**：表/图题注使用 `SEQ` 域（插入/删除自动重排），不再是静态数字；
7. **文档属性**：docProps/core.xml + app.xml（标题/作者/公司/关键词/创建时间），Word 属性面板与标题栏正常；
8. **中文排版细节**：`kern` 字距、`autoSpaceDE/DN` 中英文自动间距、`widowControl` 防孤行。

验证：重新生成 4 份样例并逐页渲染检查（封面/正文/表格/题注/页眉页脚），app-ts 132 文件 1311 用例全绿。

## 原生排版能力补齐（2026-11，第三轮）

对齐业界实现（模板 + IR + 确定性渲染器 + 渲染评测）后，本轮把剩下的大项全部落地：

1. **脚注**：IR `{type:"footnote",text}` → 正文 `w:footnoteReference`（上标，紧接上一段末尾），   `word/footnotes.xml` 含 separator/continuationSeparator 与各脚注，rels/content-types 完整；样式 FootnoteText/FootnoteReference。
2. **交叉引用**：表/图题注段落携带 `_RefTbl{n}`/`_RefFig{n}` bookmark；`{type:"crossReference",kind,index,prefix}` 渲染为 `prefix + 表 + REF 域`，   Word 中 Ctrl+Click 跳转、增删自动更新（样例「实验数据见表 1」「模块划分见表 1」）。
3. **公式 OMML**：`formula.latex` 支持 `\frac{}{}`、`\sqrt{}`、`^`/`_` 子集 → 真正的 `m:oMathPara/m:oMath`；   不支持或用户模板模式回退纯文本（避免命名空间缺失）。
4. **图片版式**：`image.wrap=inline|square|topAndBottom`（浮动用 `wp:anchor` + `wrapSquare`/`wrapTopAndBottom`，水平居中），   `captionPosition=above|below`，图片高度超过正文可用高度 60% 自动缩宽；图注仍 SEQ+bookmark。
5. **封面满出血**：色带改为段落底纹 + 负缩进（`w:ind left=-margin left / right=-margin right`），顶到纸张左右边缘。
6. **视觉回归评测**：`src/services/office/qa-visual.ts` + `scripts/office-visual-regression.ts`：DOCX→PDF→`pdftotext -bbox-layout`→归一化文本/坐标/字号 JSON，与 `test/golden/office/*.json` 比对；   `npm run eval:office [--update]`，缺 LibreOffice/poppler 时退出码 2 并明确说明，不伪造通过。
7. **预览转换**：`documentIRToPreviewBlocks` 覆盖 footnote（`[注] …`）、crossReference（`见表 N/图 N`）等全部 IR 节点。

验证：重新生成 4 份样例并逐页渲染检查（脚注上标+分离线、分数公式、REF 交叉引用、图注在上、浮动图片、满出血色带）；app-ts **133 文件 / 1336 用例全绿**（新增 renderer 9 例 + qa-visual 16 例）。`npm run eval:office` 在本机（无 LibreOffice）实测退出码 2。

仍存限制：OMML 只覆盖常用子集（矩阵/多行公式未支持）；交叉引用仅表/图题注；图片环绕仅 inline/square/topAndBottom（无四周型距离微调）；用户上传 .docx 模板模式保留用户样式（公式回退文本）；golden 视觉回归需在带 LibreOffice+poppler 的环境执行。

### 第三轮验证补充（2026-11）

- **Word 兼容性修复**：手写的最小 theme1.xml 会被 Word 判定为“文件已损坏”（LibreOffice 能打开，容易漏测）。已改为以 Word 原生主题为骨架（`src/services/office/theme-template.xml`，Word 生成、schema 合法），在渲染时替换 accent 色与中西文字体；4 份样例经 Word COM 实际打开验证通过（4/4/10/4 页）。
- 样例：调研报告补齐到 10 页；学术报告含脚注上标+分离线、OMML 分数公式、`REF` 交叉引用（「实验数据见表 1」）；技术设计含浮动图片（图注在上、`wrap=topAndBottom`）与 `模块划分见表 1`；商业方案含 `wrap=square` 图片与脚注。
- 视觉回归：`npm run eval:office [--update]`（`scripts/office-visual-regression.ts`）基于 `pdftotext -bbox-layout` 归一化文本/坐标/字号与 golden JSON 比对；本机无 LibreOffice 时实测退出码 2，不伪造结果。
- 全量测试：app-ts `133 文件 / 1336 用例` 通过。

## 第四轮：P0/P1/P2 能力落地（2026-11，按要求未跑真机）

- 渲染器 v4：段落内联标记 {{fn:脚注}} 与 {{ref:table:1}} / {{ref:heading:2}} / {{ref:formula:1}}（内联脚注与 REF 域）；标题 _RefH 与公式 _RefEq bookmark；crossReference 支持 heading/formula；TOC 两遍渲染（tocEntries + collectTocHeadings）；endnotes.xml 尾注与分节脚注重编号；图片 wrapText/distCm/floatAlign/border/captionAlign；page.columns 双栏、watermark VML 水印、chinese 页码；captionNumbering=chapter 按章题注（STYLEREF+SEQ）。
- OMML v2（omml.ts）：latexToOmml/isLatexSupported，支持矩阵、aligned/cases、n 元求和积分、left-right 嵌套定界符、text、overline 等；未知语法整体降级为文本，72 个单测。
- 模板外置与品牌：officeExport.templatesFile 指向 JSON 覆盖模板字段；brand.primaryColor 覆盖 accent、brand.logoUploadUuid 由 export 服务下载并绘制在封面；新工具 office_list_templates 已注册到 main agent。
- 事实核对：fact-check.ts 提供 FactCheckPort/collectClaims/runFactCheck；content-engine 新增 factCheck 阶段（不可用时降级，不阻塞文档）。
- CI：.github/workflows/office-eval.yml 安装 LibreOffice+poppler 后生成样例并运行 npm run eval:office；golden 缺失或差异会失败并提示 --update。
- 验证：tsc 通过；vitest 136 文件 / 1456 用例全绿。未跑 Word/LibreOffice，因此 app-ts/test/golden/office 基线尚未生成，需在有渲染器的环境执行 npm run samples:office && npm run eval:office -- --update 后提交。
- 仍存边界：品牌 logo 仅封面（页眉 logo 未做）；多栏仅 1/2 栏；事实核对尚无生产 LLM adapter 与独立工具；按章题注依赖 Word 域更新；TOC 静态页码需调用方两遍渲染。

### 视觉回归 golden 基线已生成（2026-11）

- CI 在 `office-eval` workflow 内联构建评测镜像：Debian bookworm + LibreOffice 7.4(nogui) + poppler 22 + Noto CJK，
  与 golden 生成环境完全一致；仓库不再保留 `docker/` 目录。
- 两套基线：
  - `app-ts/test/golden/office/lo/*.json`：LibreOffice 基线，**CI 使用**（同镜像生成，4/4 复现通过）；
  - `app-ts/test/golden/office/word/*.json`：Windows Word 导出 PDF 的基线，仅本机核验用，不参与 CI。
- 样例图片资源已迁到 `app-ts/test/fixtures/office/assets/`，CI 无需依赖本地 qa-output 资产。
- `eval:office` 新增 `--pdf-dir <dir>` 离线模式：直接解析已有 PDF（例如 Word 导出的 PDF），无需 LibreOffice；
  本机用它生成了 Word 基线，容器内用 LO 渲染生成了 lo 基线。
- CI workflow：内联构建评测镜像 → 容器内 `npm ci` + `npm run samples:office` + eval（`--golden test/golden/office/lo`）→ 失败给出 golden 缺失/差异/环境缺失三类中文提示并上传报告。
- 本地真机门禁（用户要求下执行）：Word COM 打开 4 份样例并导出 PDF，页数 4/4/10/4；
  LO 容器内 4/4 快照生成并通过复跑比对。
