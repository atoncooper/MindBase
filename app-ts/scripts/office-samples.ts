import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { renderDocument } from "../src/services/office/render-doc.js";
import { validateDocumentIR, type DocumentIR } from "../src/services/office/ir.js";
import { getDocTemplate } from "../src/services/office/templates.js";

const OUT = "qa-output";
const FIXTURE_ASSETS = path.join("test", "fixtures", "office", "assets");
const ASSETS = existsSync(FIXTURE_ASSETS) ? FIXTURE_ASSETS : path.join(OUT, "assets");

async function imageResolver(uploadUuid?: string) {
  const name = uploadUuid === "revenue" ? "revenue.png" : uploadUuid === "architecture" ? "architecture.png" : undefined;
  if (!name) return undefined;
  try {
    const data = await fs.readFile(path.join(ASSETS, name));
    return { data: new Uint8Array(data), mime: "image/png" };
  } catch {
    return undefined;
  }
}

async function write(name: string, doc: DocumentIR) {
  const validated = validateDocumentIR(doc);
  const template = getDocTemplate(validated.template);
  const bytes = await renderDocument({ ir: validated, template, resolveImage: (image) => imageResolver(image.uploadUuid) });
  await fs.writeFile(path.join(OUT, name + ".docx"), bytes);
  await fs.writeFile(path.join(OUT, name + ".ir.json"), JSON.stringify(validated, null, 2));
  console.log("wrote", name + ".docx", bytes.length, "bytes, template=" + template.id);
  return bytes;
}
const lorem = "在调研过程中，团队按区域与行业分层抽样，共回收有效问卷 812 份，并完成 36 场深度访谈。样本结构与平台现有用户画像基本一致，误差控制在 3 个百分点以内。";
const researchSections = [
  {
    heading: "调研背景与方法",
    blocks: [
      { type: "paragraph", text: "2026 年 7 月至 9 月，项目组围绕中小企业数字化转型的实际需求开展调研。调研覆盖华东、华南与西南三个区域，涉及制造、零售与专业服务三个行业。" },
      { type: "paragraph", text: "调研采用线上问卷与线下访谈结合的方式：问卷面向企业负责人与信息化负责人发放，访谈对象包括 12 家已采购数字化工具的企业和 8 家尚未采购的企业。" },
      { type: "kv", columns: 2, items: [
        { label: "调研时间", value: "2026.07–2026.09" },
        { label: "样本量", value: "812 份有效问卷" },
        { label: "覆盖区域", value: "华东 / 华南 / 西南" },
        { label: "访谈数量", value: "36 场" },
      ] },
      { type: "paragraph", text: lorem },
    ],
  },
  {
    heading: "主要发现",
    blocks: [
      { type: "paragraph", text: "调研结果显示，企业采购数字化工具的首要动因是降低人工成本（提及率 61%），其次是提升交付效率（52%）和满足客户要求（37%）。价格敏感度高于预期，超过六成企业在预算审批环节受阻。" },
      { type: "metrics", items: [
        { label: "有效问卷", value: "812 份", note: "覆盖 3 个区域" },
        { label: "已采购工具", value: "58%", note: "较 2025 年 +9pp" },
        { label: "预算受阻", value: "63%", note: "审批周期 > 3 个月" },
      ] },
      { type: "table", caption: "表 1 采购动因分布（多选）", headers: ["动因", "提及率", "较 2025 年"], rows: [["降低人工成本", "61%", "+4pp"], ["提升交付效率", "52%", "+6pp"], ["满足客户要求", "37%", "+1pp"], ["合规与审计", "24%", "-2pp"]] },
      { type: "callout", title: "关键判断", tone: "warning", text: "预算审批周期而非产品能力，是当前转化率的主要瓶颈。缩短试用与报价之间的决策链条，比继续增加功能更有价值。" },
    ],
  },
  {
    heading: "细分人群差异",
    blocks: [
      { type: "paragraph", text: "按企业规模分层后，100 人以下企业对价格最敏感，倾向按年订阅且要求随时可退；300 人以上企业更关注权限、审计与私有化部署，愿意为实施服务付费。" },
      { type: "paragraph", text: "制造业客户的调研反馈集中在现场协同与设备数据接入，零售客户更关心会员运营与库存周转。两类客户的共性需求是报表可导出、口径可追溯。" },
      { type: "unorderedList", items: [
        "小微企业：预算 5 万元以内，决策链短，试用转化快",
        "中型企业：预算 10–30 万元，需要部门级试点与 ROI 证明",
        "大型企业：预算 50 万元以上，要求私有化、审计与 SLA",
      ] },
      { type: "paragraph", text: "这一差异意味着单一产品包难以覆盖全部客群，需要按规模设计交付与定价组合。" },
    ],
  },
  {
    heading: "问题与原因分析",
    blocks: [
      { type: "paragraph", text: "访谈中反复出现的问题是「买了用不起来」。工具上线三个月后，活跃账号占采购账号的比例中位数只有 41%。原因主要集中在三方面：缺少与现有系统的数据打通、一线员工缺少培训、管理层没有把使用情况纳入考核。" },
      { type: "paragraph", text: "进一步分析发现，能够提供实施陪跑的服务商，其客户三个月活跃率平均高出 22 个百分点。这说明交付能力而非功能数量，决定了工具能否真正产生价值。" },
      { type: "table", caption: "表 2 活跃率与交付方式的关系", headers: ["交付方式", "样本数", "三个月活跃率"], rows: [["仅开通账号", "212", "29%"], ["线上培训", "186", "38%"], ["实施陪跑", "154", "63%"]] },
    ],
  },
  {
    heading: "建议",
    blocks: [
      { type: "orderedList", items: [
        "把实施陪跑作为标准交付的一部分，按客户规模配置 2–6 周的服务包，并在合同中约定活跃率目标。",
        "优先打通企业已有的财务与进销存系统，减少重复录入；为首批客户提供数据迁移模板。",
        "针对小微企业推出按季度订阅与随时退订，降低首次决策成本；针对大型企业提供私有化与审计能力清单。",
        "建立客户成功看板，把活跃率、任务完成率与续约风险纳入同一套指标。",
      ] },
      { type: "paragraph", text: "上述建议需要在 2027 年第一季度前完成试点验证。建议选择 20 家客户开展对照实验，以三个月活跃率与续约意向作为主要评估指标。" },
    ],
  },
  {
    heading: "典型案例",
    blocks: [
      { type: "paragraph", text: "案例一：某区域连锁零售企业在 2025 年采购了一套会员运营工具，上线三个月后活跃账号占比仅 32%。复盘发现，门店店长没有把工具纳入日常例会，数据也没有与总部报表打通。2026 年重新上线时，企业把使用情况纳入店长考核，并安排两周驻场培训，三个月活跃率提升到 68%。" },
      { type: "paragraph", text: "案例二：一家年营收 3 亿元的制造企业选择私有化部署，项目周期 4 个月。项目组把设备数据采集、工单流转与质量追溯拆成三期交付，每期验收后再进入下一期，最终在一线班组形成了稳定使用习惯。该企业后续追加了第二个工厂的部署预算。" },
      { type: "paragraph", text: "案例三：某专业服务机构规模不足 80 人，预算有限，选择按季度订阅。由于缺少专职信息化人员，前两个月几乎未使用；服务商提供远程陪跑后，把工具嵌入到项目交付流程中，第三个月活跃率达到 74%，并在续约时升级到年付。" },
      { type: "table", caption: "表 6 三个案例的关键差异", headers: ["案例", "规模", "交付方式", "三个月活跃率"], rows: [["连锁零售", "1,200 人", "驻场培训+考核", "68%"], ["制造企业", "2,600 人", "分三期私有化交付", "71%"], ["专业服务", "80 人", "远程陪跑", "74%"]] },
      { type: "paragraph", text: "三个案例的共同点是：工具本身没有差异，决定成败的是交付方式与组织配套。这一点与问卷结论相互印证。" },
    ],
  },
  {
    heading: "替代方案与竞品观察",
    blocks: [
      { type: "paragraph", text: "调研中企业实际使用的替代方案包括通用办公套件、垂直写作工具、外包定制开发与人工流程。四类方案在成本、灵活性与可维护性上各有取舍。" },
      { type: "table", caption: "表 7 替代方案对比", headers: ["方案", "初始成本", "维护成本", "适用场景"], rows: [["通用办公套件", "低", "低", "轻量文档与表格"], ["垂直写作工具", "中", "低", "营销与内容团队"], ["外包定制", "高", "高", "强流程耦合场景"], ["人工流程", "极低", "隐性高", "低频、非标准需求"]] },
      { type: "paragraph", text: "竞品观察显示，头部产品正在从单点工具转向平台化：一方面补齐团队协作与权限，另一方面通过模板市场降低启动成本。这对新进入者的启示是，单纯比拼生成质量难以形成壁垒，模板生态与交付能力更可能成为差异化来源。" },
      { type: "paragraph", text: "同时也要看到，平台化会带来更高的实施复杂度。调研中有 11 家企业因为功能过多而放弃采购，理由是「用不到那么多功能，还要为培训付费」。产品需要提供清晰的轻量入口。" },
    ],
  },
  {
    heading: "实施建议与优先级",
    blocks: [
      { type: "paragraph", text: "综合问卷、访谈与案例，建议把改进拆成三个优先级：先解决上线期服务，再优化采购流程，最后建设模板生态。" },
      { type: "orderedList", items: [
        "P0：把实施陪跑产品化，形成 2 周 / 4 周 / 6 周三档服务包，明确交付物与验收标准。",
        "P0：提供标准数据迁移模板与自助权限配置向导，把上线期人力投入降低 30%。",
        "P1：设计面向财务与采购部门的价值说明材料，缩短预算审批周期。",
        "P1：按区域与规模设计订阅组合，降低首次决策门槛。",
        "P2：建设模板市场，引入行业合作伙伴共建模板，形成可复用的交付资产。",
      ] },
      { type: "paragraph", text: "每项改进都需要可量化指标：上线周期、三个月活跃率、续约率与实施人力投入。建议在季度经营会上复盘一次，避免改进停留在方案层面。" },
      { type: "callout", title: "落地前提", tone: "success", text: "先把 20 家试点客户跑通，再扩大投入；在没有验证续约率提升之前，不建议大规模扩张实施团队。" },
    ],
  },
  {
    heading: "区域与行业差异",
    blocks: [
      { type: "paragraph", text: "华东地区企业对订阅制的接受度最高，愿意按年付费的比例达到 71%；华南地区企业更偏好一次性买断加实施服务；西南地区受预算限制，按季度付费的意向明显更强。" },
      { type: "paragraph", text: "行业维度上，零售与专业服务对云端方案的接受度较高，制造业则普遍要求本地部署与设备数据接口。调研中有 14 家制造企业明确提出希望提供边缘侧采集能力。" },
      { type: "table", caption: "表 4 区域偏好对比", headers: ["区域", "按年订阅", "买断+实施", "按季度付费"], rows: [["华东", "71%", "18%", "11%"], ["华南", "52%", "33%", "15%"], ["西南", "44%", "21%", "35%"]] },
      { type: "paragraph", text: "这一分布提示销售策略需要区域化：华东主推订阅，华南主推实施服务包，西南以低门槛试用切入。" },
    ],
  },
  {
    heading: "客户旅程中的关键节点",
    blocks: [
      { type: "paragraph", text: "从首次接触到续约，客户旅程可以拆成试用、采购、上线、扩量与续约五个阶段。每个阶段的流失原因不同，需要的干预也不同。" },
      { type: "unorderedList", items: [
        "试用期：缺少与真实业务数据结合的示例，导致价值感知弱",
        "采购期：预算审批与安全评估周期长，销售难以维持热度",
        "上线期：数据迁移与权限配置消耗大量实施人力",
        "扩量期：缺少部门间的横向推广机制，使用范围停滞",
        "续约期：续约决策依赖使用数据，但客户拿不到完整报表",
      ] },
      { type: "paragraph", text: "调研中有 9 家企业在上线期停滞超过两个月，其中 6 家最终没有完成续约。上线期的服务投入与续约率呈明显正相关。" },
      { type: "callout", title: "建议", text: "把上线期拆成可验收的里程碑（数据迁移完成、首批用户培训完成、关键报表上线），由客户成功团队逐项确认，避免项目无限期拖延。" },
    ],
  },
  {
    heading: "结论与后续研究",
    blocks: [
      { type: "paragraph", text: "本次调研的结论可以概括为三点：需求真实存在但预算审批是主要瓶颈；交付能力决定使用深度；区域与行业差异要求差异化定价与交付。" },
      { type: "paragraph", text: "研究的局限在于样本以线上渠道为主，对完全不使用数字化工具的企业覆盖不足。后续将补充线下样本，并跟踪 20 家试点客户六个月的使用数据，验证实施陪跑对续约率的实际影响。" },
      { type: "table", caption: "表 5 后续研究计划", headers: ["阶段", "时间", "主要工作"], rows: [["试点招募", "2026.12", "确定 20 家试点客户"], ["数据跟踪", "2027.01–2026.06", "活跃率、任务完成率、续约意向"], ["结果发布", "2027.07", "形成第二版调研报告"]] },
    ],
  },
  {
    heading: "方法说明与数据质量",
    blocks: [
      { type: "paragraph", text: "为避免样本偏差，项目组在发放问卷时按区域与行业设定了配额，并对回收数据进行清洗：剔除填写时长不足 90 秒、逻辑矛盾与重复 IP 的问卷，共剔除 76 份，最终保留 812 份有效样本。" },
      { type: "paragraph", text: "访谈采取半结构化方式，每次 45–60 分钟，全程录音并在 24 小时内整理成文字稿；两位研究员独立编码，编码不一致的条目由第三人裁定。编码结果与问卷数据进行交叉验证，用来解释统计结果的成因。" },
      { type: "paragraph", text: "数据质量的局限主要有两点：一是线上样本对企业规模存在高估，小微企业的实际占比可能更高；二是访谈对象以已经采购工具的企业为主，对观望群体的覆盖不足。这两点在解读结论时需要保留。" },
      { type: "table", caption: "表 8 数据清洗记录", headers: ["步骤", "数量", "说明"], rows: [["回收问卷", "888", "含重复与无效"], ["剔除", "76", "时长/逻辑/IP"], ["有效样本", "812", "用于分析"], ["有效访谈", "36", "文字稿 21 万字"]] },
      { type: "paragraph", text: "所有原始数据与编码手册已归档，后续研究可在同一口径下补充样本，保证跨期可比。" },
      { type: "paragraph", text: "为了保证结论可复核，项目组把问卷原始数据、访谈编码表与清洗脚本一并存档，并在附录中给出了指标定义与计算口径；后续复现研究可直接沿用同一份口径，减少因定义差异带来的偏差。" },
    ],
  },
  {
    heading: "数据分析方法",
    blocks: [
      { type: "paragraph", text: "问卷数据用 Python 与电子表格完成清洗，统计口径以企业为分析单位，同一企业的多份问卷取负责人版本。对缺失值采用同区域同规模的中位数插补，插补比例控制在 5% 以内，避免对整体分布造成明显影响。" },
      { type: "paragraph", text: "分层对比采用交叉表与卡方检验，对样本量较小的分组只报告频数与占比，不做显著性推断。访谈材料按主题编码，由两位研究员独立编码后计算一致性系数，对分歧条目进行讨论后定稿。" },
      { type: "table", caption: "表 9 主要指标的定义", headers: ["指标", "定义", "取值方式"], rows: [["数字化投入", "过去 12 个月软件与实施服务支出", "区间中位数"], ["使用活跃率", "月活跃账号 / 采购账号", "百分比"], ["预算审批周期", "从立项到合同签署的时间", "中位数（月）"], ["续约意向", "明确表示会续约的企业占比", "百分比"]] },
      { type: "paragraph", text: "所有分析脚本与脱敏后的数据保存在项目共享目录，报告中的每个数字都可以回溯到对应的问卷编号或访谈记录，方便后续复核与更新。" },
      { type: "paragraph", text: "需要说明的是，本次数据以自报口径为主，企业可能倾向高报投入或低报预算，因此在解读金额类指标时应结合访谈材料交叉验证，避免把单一来源的数字当作事实。" },
    ],
  },
  {
    heading: "附录：调研问卷结构",
    blocks: [
      { type: "paragraph", text: "问卷共 28 题，分为企业基本信息、数字化现状、采购决策、使用体验与开放建议五个部分。访谈提纲在此基础上补充了实施过程与组织协同的问题。" },
      { type: "paragraph", text: "问卷的发放与回收由项目组统一管理，所有样本均经过唯一的用户标识去重。为避免渠道偏差，线上问卷在三个区域分别投放，并按企业规模设置了配额；线下访谈由区域研究员完成，访谈记录统一按编码手册整理。" },
      { type: "paragraph", text: "数据清洗完成后，项目组对关键指标进行了交叉核对：问卷中的员工规模、行业分类与公开工商信息一致率达到 94%，收入区间与访谈中提到的量级基本吻合。对不一致的样本，团队以访谈记录为准进行了修正，并在数据说明中标注。" },
      { type: "paragraph", text: "本报告的分析以描述性统计为主，辅以分层对比与案例归纳。由于样本并非严格随机抽样，结论更适合用于发现方向性差异，而不是推断总体比例；涉及金额的指标均以区间中位数呈现，避免小数点带来的精度错觉。" },
      { type: "paragraph", text: "后续如扩大样本，建议补充中西部地区的制造业企业与 50 人以下的小微企业，并在问卷中增加对采购审批流程、数据安全要求的细化问题，以便与本次结论进行对照。" },
      { type: "table", caption: "表 3 问卷结构", headers: ["部分", "题量", "主要内容"], rows: [["企业基本信息", "6", "规模、行业、区域"], ["数字化现状", "8", "系统、数据、人员"], ["采购决策", "6", "预算、审批、决策链"], ["使用体验", "6", "活跃、培训、支持"], ["开放建议", "2", "期望与痛点"]] },
    ],
  },
];

const research: DocumentIR = {
  version: 1,
  template: "research-report",
  title: "中小企业数字化转型需求调研报告",
  subtitle: "基于 812 份问卷与 36 场访谈的分析",
  meta: { author: "用户研究组", organization: "示例研究院", date: "2026 年 11 月", keywords: ["数字化转型", "中小企业", "调研"] },
  toc: true,
  cover: true,
  header: "{title}",
  sections: researchSections,
};

const business: DocumentIR = {
  version: 1,
  template: "business-plan",
  title: "智能文档助手商业化方案",
  subtitle: "2027 年产品与增长计划",
  meta: { author: "产品与商业化团队", organization: "示例科技", date: "2026 年 11 月", docNo: "BP-2027-03" },
  toc: true,
  cover: true,
  sections: [
    { heading: "执行摘要", blocks: [
      { type: "paragraph", text: "本方案面向中小企业提供文档智能生成与排版能力，以订阅制收费，2027 年目标实现 1,200 万元年度经常性收入（ARR）。" },
      { type: "metrics", items: [{ label: "目标 ARR", value: "1,200 万元", note: "2027 年底" }, { label: "付费客户", value: "3,000 家", note: "净增 2,100" }, { label: "毛利率", value: "68%", note: "含基础设施" }] },
      { type: "paragraph", text: "增长路径分为三步：先用免费额度获取自助用户，再通过模板与团队协作转化为付费，最后以私有化与行业方案提升客单价。" },
      { type: "footnote", text: "ARR（Annual Recurring Revenue）指年度经常性收入，按订阅合同金额年化计算。" },
    ] },
    { heading: "市场与竞争", blocks: [
      { type: "paragraph", text: "目标市场为 100–1,000 人规模的企业，预算区间 5–30 万元。当前竞争主要来自通用办公套件与垂直写作工具，前者缺少模板深度，后者缺少团队与权限能力。" },
      { type: "table", caption: "表 1 竞争格局", headers: ["类型", "代表产品", "优势", "缺口"], rows: [["通用办公套件", "办公软件", "渗透率高", "模板与自动化弱"], ["垂直写作工具", "AI 写作", "体验轻", "团队协作弱"], ["设计排版工具", "在线设计", "视觉强", "文档结构弱"]] },
      { type: "image", uploadUuid: "revenue", caption: "季度收入预测", widthCm: 11, wrap: "square" },
    ] },
    { heading: "实施路径", blocks: [
      { type: "orderedList", items: [
        "2027 Q1：完成模板中心与团队协作公测，建立 20 个行业模板。",
        "2027 Q2：上线订阅与用量计费，验证自助转化路径。",
        "2027 Q3：推出私有化版本与实施服务包，进入大客户市场。",
        "2027 Q4：通过渠道合作覆盖区域市场，完成年度目标。",
      ] },
      { type: "table", caption: "表 2 资源投入", headers: ["项目", "预算（万元）", "负责人"], rows: [["产品研发", "420", "产品部"], ["市场与渠道", "260", "增长部"], ["实施与客户成功", "180", "服务部"]] },
    ] },
    { heading: "风险与应对", blocks: [
      { type: "table", caption: "表 3 主要风险", headers: ["风险", "影响", "应对"], rows: [["大模型成本上涨", "毛利承压", "缓存与模型路由"], ["企业采购周期拉长", "回款变慢", "季度订阅与试点"], ["竞品价格战", "转化下降", "行业方案差异化"]] },
      { type: "callout", title: "关键假设", tone: "warning", text: "方案成立的前提是自助用户月活转化率不低于 6%，若连续两个月低于 4%，应暂停渠道扩张，回到产品验证。" },
    ] },
  ],
};

const tech: DocumentIR = {
  version: 1,
  template: "tech-design",
  title: "文档服务技术设计",
  subtitle: "Office 生成与渲染链路",
  meta: { author: "平台架构组", date: "2026 年 11 月", docNo: "TD-2026-042" },
  toc: true,
  cover: true,
  sections: [
    { heading: "背景与目标", blocks: [
      { type: "paragraph", text: "现有文档生成链路以字符串拼接生成 OOXML，缺少样式层与渲染检查，导致版式不可控且难以支持模板。本次改造目标是建立内容、模板、渲染、质检四层解耦的链路。" },
      { type: "unorderedList", items: ["统一文档中间表示（IR），内容与排版解耦", "内置 8 套模板并支持用户上传 .docx 模板", "生成后自动渲染为 PDF 并执行版式检查"] },
    ] },
    { heading: "总体架构", blocks: [
      { type: "image", uploadUuid: "architecture", caption: "文档服务架构", widthCm: 14, wrap: "topAndBottom", captionPosition: "above" },
      { type: "paragraph", text: "内容引擎输出 Document IR；模板引擎根据文档类型与用户指定选择模板并映射样式；DOCX 渲染器生成原生段落、表格、图片、页眉页脚与分页；质检模块将 DOCX 转换为 PDF，检查文本越界、空白页、标题层级与字体一致性。" },
      { type: "table", caption: "表 1 模块职责", headers: ["模块", "输入", "输出"], rows: [["内容引擎", "需求与素材", "Document IR"], ["模板引擎", "IR 元数据", "模板与样式映射"], ["渲染器", "IR + 模板", "DOCX"], ["质检", "DOCX", "检查报告与页面图"]] },
      { type: "crossReference", kind: "table", index: 1, prefix: "模块划分见" },
    ] },
    { heading: "接口设计", blocks: [
      { type: "heading", level: 2, text: "生成接口" },
      { type: "codeBlock", language: "ts", code: "interface ComposeRequest {\n  brief: string;\n  template: DocumentTemplateId;\n  audience?: string;\n}\n\ninterface ComposeResult {\n  document: DocumentIR;\n  quality: QualityReport;\n}" },
      { type: "heading", level: 2, text: "渲染接口" },
      { type: "codeBlock", language: "ts", code: "renderDocument({ ir, template, resolveImage }): Promise<Buffer>" },
    ] },
    { heading: "部署与运维", blocks: [
      { type: "orderedList", items: ["镜像内置 LibreOffice 与 poppler，用于 DOCX→PDF→PNG。", "质检任务异步执行，单文档上限 5 分钟，失败降级为结构检查。", "模板与字体随镜像发布，缺失字体在日志中告警。"] },
      { type: "callout", title: "注意事项", tone: "info", text: "LibreOffice 对 OOXML 的边框解析与 Word 存在差异，不可见边框需使用白色 hairline 而非 val=nil。" },
    ] },
  ],
};

const academic: DocumentIR = {
  version: 1,
  template: "academic",
  title: "基于结构约束的文档生成质量评估方法",
  subtitle: "研究方法示例文档",
  meta: { author: "示例作者", organization: "示例大学信息学院", date: "2026 年 11 月", keywords: ["文档生成", "结构约束", "质量评估"] },
  toc: true,
  cover: true,
  sections: [
    { heading: "引言", blocks: [
      { type: "paragraph", text: "自动文档生成的质量评价长期依赖人工阅读，缺乏可复现的量化标准。本文提出一种基于结构约束的评估方法，将版式、内容与一致性拆分为可观测指标。" },
      { type: "paragraph", text: "与既有工作相比，本文的贡献在于：把文档中间表示作为评估对象，使不同渲染器之间的比较成为可能；并给出一组可在生成阶段约束的规则。" },
      { type: "footnote", text: "本文所指的渲染器包括本项目的 DOCX 渲染器与 LibreOffice 导出链路，二者共用同一份 IR。" },
    ] },
    { heading: "相关工作", blocks: [
      { type: "paragraph", text: "早期研究多关注文本连贯性，忽略了版式对可读性的影响。近期工作开始引入视觉语言模型评估页面质量，但评估对象通常是渲染后的图片，难以定位到具体结构节点。" },
      { type: "paragraph", text: "本文方法介于两者之间：在结构层约束内容，在渲染层验证结果。" },
    ] },
    { heading: "方法", blocks: [
      { type: "paragraph", text: "给定文档结构 D 与模板 T，评估目标定义为内容合理性、版式一致性与可读性三部分的加权和。内容合理性由规则检查与模型评审共同给出。" },
      { type: "formula", text: "Q(D, T) = α·C(D) + β·L(D, T) + γ·R(D, T)", latex: "Q = \\frac{\\alpha C + \\beta L + \\gamma R}{1}" },
      { type: "paragraph", text: "其中 C 表示内容得分，L 表示版式得分，R 表示可读性得分，权重之和为 1。实际应用中 α 取 0.5，β 与 γ 各取 0.25。" },
    ] },
    { heading: "实验", blocks: [
      { type: "paragraph", text: "我们在 40 份中文文档上比较了规则评估与人工评分的一致性。每份文档由两名评审独立打分，取平均值作为标签。" },
      { type: "table", caption: "表 1 评估结果", headers: ["方法", "皮尔逊相关系数", "平均绝对误差"], rows: [["仅内容规则", "0.62", "8.4"], ["内容+版式", "0.78", "5.1"], ["本文完整方法", "0.83", "4.2"]] },
      { type: "crossReference", kind: "table", index: 1, prefix: "实验数据见" },
      { type: "paragraph", text: "结果显示，加入版式指标后与人工评分的一致性显著提升；完整方法在高分区间仍存在低估，主要来自对图表可读性的判断差异。" },
    ] },
    { heading: "结论", blocks: [
      { type: "paragraph", text: "结构约束为文档生成质量提供了可执行的中间层。后续工作将扩展到多语言排版与协作编辑场景。" },
      { type: "reference", items: ["[1] 示例参考文献：文档生成与版式评估研究. 2025.", "[2] 示例参考文献：结构化文档中间表示. 2024.", "[3] 示例参考文献：视觉语言模型在版面分析中的应用. 2026."] },
    ] },
  ],
};

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  await write("research-report", research);
  await write("business-plan", business);
  await write("tech-design", tech);
  await write("academic-report", academic);
  console.log("samples done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});