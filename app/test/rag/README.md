# RAG 测试

`app/test/rag/` — RAG 检索 / 生成质量测试工具集。

## 文件一览

| 文件 | 类型 | 用途 |
|------|------|------|
| [test_rerank.py](test_rerank.py) | pytest 单元 | rerank 策略模式(38 用例,无外部依赖) |
| [rerank_benchmark.py](rerank_benchmark.py) | CLI | rerank 控制变量测试(内存)+ Mmarco 量化 + 可视化 |
| [eval_ingest.py](eval_ingest.py) | CLI | 端到端入库评测(Mmarco,Recall@k/NDCG@k) |
| [eval_uid.py](eval_uid.py) | CLI | uid 隔离评测(NFCorpus,uid scope + Recall@pool 诊断) |
| [eval_ragas.py](eval_ragas.py) | CLI | RAGAS 生成质量评测(faithfulness/relevancy/precision) |
| [fetch_beir.py](fetch_beir.py) | CLI | 下载 BEIR 英文集(NFCorpus,zip) |
| [fetch_hf.py](fetch_hf.py) | CLI | 下载 HuggingFace 中文集(Mmarco-reranking) |
| [plot_utils.py](plot_utils.py) | 模块 | 统一绘图(字体/配色/版本管理) |
| [diagnose_rag.py](diagnose_rag.py) | 脚本 | RAG 全链路自检(Milvus+embedding+LLM) |
| test_vector_*.py | pytest | 向量存储/搜索/API/模型/任务测试 |

## 前置依赖

```bash
pip install datasets matplotlib ragas
```

- **Milvus 连接**:端到端评测(eval_ingest/eval_uid/eval_ragas)、diagnose
- **DashScope API key**:rerank(dashscope)/ 生成(qwen3-max)/ judge(qwen-plus),同 key 即可

## 测试流程(由轻到重)

### 1. 单元测试 — 纯算法,无外部依赖

```bash
pytest app/test/rag/test_rerank.py -v
```

覆盖 rerank 5 策略(null/dashscope/hybrid/mmr/llm)+ 调度 + fallback + immutability。应 38 passed。

### 2. rerank 控制变量测试 — 内存,定性

```bash
# 内置 fixture
python -m app.test.rag.rerank_benchmark --query "猫的习性" --strategies null,hybrid,mmr --k 3

# Mmarco 量化(positive 排第一比例)
python -m app.test.rag.rerank_benchmark --from-mmarco --strategies null,dashscope --limit 100

# 出图
python -m app.test.rag.rerank_benchmark --query "..." --strategies null,dashscope,hybrid,mmr --plot out.png
```

### 3. 端到端检索评测 — 入库 + Recall@k/NDCG@k

**Mmarco(中文 rerank 集,hard negative)**:

```bash
python -m app.test.rag.fetch_hf --summarize
python -m app.test.rag.eval_ingest --ingest --limit 100
python -m app.test.rag.eval_ingest --eval --hybrid --strategies null,dashscope --k 5
python -m app.test.rag.eval_ingest --cleanup
```

**NFCorpus + uid 隔离(英文,非 hard negative,完整 corpus+qrels)**:

```bash
python -m app.test.rag.fetch_beir --dataset nfcorpus --summarize
python -m app.test.rag.eval_uid --ingest --n-uids 5
python -m app.test.rag.eval_uid --eval --hybrid --strategies null,dashscope --k 5
python -m app.test.rag.eval_uid --cleanup
```

`eval_uid` 输出 **Recall@pool**(召回池命中率,诊断召回瓶颈)+ Recall@k + NDCG@k。

### 4. 生成质量评测 — RAGAS

```bash
pip install ragas datasets
python -m app.test.rag.eval_ragas --limit 20 --hybrid
python -m app.test.rag.eval_ragas --limit 20          # 纯向量对比
```

测 3 个生成指标(judge LLM = qwen-plus,同源减偏倚):
- **Faithfulness**:答案是否忠于 context(防幻觉)
- **Answer Relevancy**:答案是否回答 query
- **Context Precision**:检索 context 相关度

### 5. BM25 Hybrid Search(向量 + BM25 + RRF)

详见 [plan/1.0.1-BM25.md](../../../plan/1.0.1-BM25.md)。已实现:
- schema 加 text analyzer + `sparse_embedding` + BM25 function
- `hybrid_search` 方法(dense ANN + sparse BM25 + RRF 融合)
- analyzer 配置化:`chinese`(生产 B站中文)/ `standard`(英文测试)

### 6. RAG 全链路自检

```bash
python -m app.test.rag.diagnose_rag
```

CLAUDE.md P0 自检,提交前必跑。

## 命名规范 + 版本管理

所有图经 [plot_utils.py](plot_utils.py) 统一保存到 `metrics/`,命名 `<eval_type>_<dataset>_<method>_<k>`:

| eval | 图名 base |
|------|-----------|
| eval_uid | `retrieval_nfcorpus_hybrid_k5` / `retrieval_nfcorpus_vector_k5` |
| eval_ingest | `retrieval_mmarco_k5` |
| eval_ragas | `generation_hybrid_k5` / `generation_vector_k5` |

每次跑生成**两个文件**:
- `<name>_<YYYYMMDD_HHMMSS>.png` — 历史(时间戳,永不覆盖,可追溯对比)
- `<name>_latest.png` — 最新(覆盖,方便看当前)

```
metrics/
├── retrieval_nfcorpus_hybrid_k5_20260718_181900.png   ← 历史
├── retrieval_nfcorpus_hybrid_k5_20260718_193012.png
├── retrieval_nfcorpus_hybrid_k5_latest.png           ← 最新
└── generation_hybrid_k5_latest.png
```

统一风格:SimHei 字体、固定配色(Recall 蓝/NDCG 绿/Pool 红/Faithfulness 紫)、柱顶标百分比。

## 配置

```yaml
# app/config/default.yaml
rerank:
  enabled: true              # 默认开启
  provider: dashscope        # gte-rerank-v2 cross-encoder
  model: gte-rerank-v2
  top_n: 30                  # over-recall 召回数

milvus:
  analyzer: chinese          # text analyzer: chinese(jieba) / standard(英文)
```

```bash
# .env
RERANK__API_KEY=sk-xxx       # 留空 fallback 到 LLM__API_KEY
```

## 数据集

| 数据集 | 来源 | 语言 | 特点 | 用途 |
|--------|------|------|------|------|
| Mmarco-reranking | `C-MTEB/Mmarco-reranking`(HF) | 中文 | hard negative,只有正负对 | rerank 评测 |
| NFCorpus | BEIR zip | 英文 | 完整 corpus+qrels,非 hard negative | 检索评测(hybrid 价值能体现) |

**国内下载 HF 需镜像**:
```bash
export HF_ENDPOINT=https://hf-mirror.com
```

## 指标速查

| 指标 | 含义 | 命令 |
|------|------|------|
| Recall@k | top-k 含相关文档比例 | eval_ingest/eval_uid `--eval` |
| NDCG@k | 位置加权相关性 | 同上 |
| Recall@pool | 召回池里 positive 命中率(诊断召回瓶颈) | eval_uid `--eval` |
| Faithfulness | 答案忠于 context(防幻觉) | eval_ragas |
| Answer Relevancy | 答案回答 query | eval_ragas |
| Context Precision | 检索 context 相关度 | eval_ragas |

## 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| 中文乱码 | Windows GBK | `PYTHONIOENCODING=utf-8` 或 VSCode 查看 |
| HF 下载失败 | 网络 | `HF_ENDPOINT=https://hf-mirror.com` |
| dashscope 403 | 免费额度耗尽 | 开通付费 / 换 model |
| dashscope 评测慢 | 每 query 1 次 API | `--limit` 减小 |
| `Recall@pool` 低 | 召回瓶颈(embedding) | 换 embedding(bge-m3)/ 增 recall_n |
| `Recall@pool` 高但 Recall@k 低 | rerank 瓶颈 | 换 BGE-Reranker |
| ragas API 报错 | 版本(0.1 vs 0.2) | 贴 traceback 调 |
| `Dataset not found` | HF repo 名 | `fetch_hf` 用 `C-MTEB/Mmarco-reranking` |
| `mmarco_eval`/`uid_eval` 残留 | 忘记 cleanup | `--cleanup` |

## 相关文档

- Rerank 实现: [app/services/rag/rerank.py](../../services/rag/rerank.py)
- BM25 Hybrid 计划: [plan/1.0.1-BM25.md](../../../plan/1.0.1-BM25.md)
- 项目规范: [CLAUDE.md](../../../CLAUDE.md)
