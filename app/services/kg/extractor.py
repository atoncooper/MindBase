"""KgExtractor — 从 ASR 正文抽取实体与关系（LLM structured output）。

设计：
- 使用 ``with_structured_output`` 强约束输出（quiz 链路同款模式）
- **防幻觉边**：每条关系必须携带原文引文 quote，校验在 resolver 中进行
- 模型/成本护栏走配置：kg.extract_model / kg.max_text_chars

定位：只负责调 LLM 产出 ExtractionResult；归一化/校验/写库分别在
resolver.py 与 service.py。
"""

from __future__ import annotations

from typing import Any

from loguru import logger
from pydantic import BaseModel, Field

from app.infra.config import config


class ExtractedEntity(BaseModel):
    """LLM 抽取出的单个实体。"""

    name: str = Field(description="实体名称，尽量使用视频中出现的原文叫法")
    type: str = Field(
        default="other",
        description="实体类型: person/org/concept/tech/tool/book/event/method/place/other",
    )
    description: str = Field(
        default="", description="一句话描述该实体在本视频中的含义或角色"
    )
    quote: str = Field(
        default="",
        description="原文中明确提到该实体的片段摘抄（20字以内），找不到就留空",
    )


class ExtractedRelation(BaseModel):
    """LLM 抽取出的单条关系（必须携带原文证据）。"""

    src: str = Field(description="起点实体名，必须与 entities 中某个 name 一致")
    dst: str = Field(description="终点实体名，必须与 entities 中某个 name 一致")
    relation_type: str = Field(
        description="关系动词短语，如 讲解了/使用了/提出了/对比了/依赖于/属于"
    )
    quote: str = Field(
        description="支持该关系的原文片段（直接摘抄，20字以内），禁止编造"
    )


class ExtractionResult(BaseModel):
    """一次分P抽取的完整结果。"""

    entities: list[ExtractedEntity] = Field(default_factory=list)
    relations: list[ExtractedRelation] = Field(default_factory=list)


EXTRACTION_SYSTEM_PROMPT = """\
你是知识图谱构建专家，从视频文字稿中抽取「实体」和「实体间关系」。

## 实体抽取规则
1. 只抽取**具体、有信息量**的实体：人物(person)、组织机构(org)、技术概念\
(concept)、技术/框架/算法(tech)、工具/软件(tool)、书籍/论文(book)、事件\
(event)、方法论(method)、地点(place)
2. 忽略：泛指词（"大家""这个方法"）、无实义的普通名词、纯口语填充
3. name 使用视频中的原文叫法；type 从给定枚举中选择
4. description 用一句话说明该实体在**本视频语境下**的含义，不超过 50 字
5. quote 是文字稿中提到该实体的原文摘抄（20 字以内）；找不到原文就留空，\
禁止编造
6. 单个视频片段最多 30 个实体，宁缺毋滥

## 关系抽取规则
1. 只抽取文本稿中**明确表达**的关系；禁止根据常识推测文中未提及的关系
2. src/dst 必须严格等于已抽取实体的 name
3. relation_type 用简短中文动词短语（讲解了/使用了/提出了/对比了/依赖了/创立了）
4. **quote 必须是文字稿的原文摘抄**（20 字以内），作为该关系的证据；\
找不到原文支撑就放弃这条关系
5. 单个视频片段最多 40 条关系

## 输出
严格按照 schema 返回 JSON，没有实体时返回空列表。
"""


class KgExtractor:
    """LLM 抽取器。惰性初始化 LLM（首次调用才建立客户端）。"""

    def __init__(self) -> None:
        self._structured_llm: Any | None = None

    def _get_structured_llm(self) -> Any:
        if self._structured_llm is None:
            from langchain_openai import ChatOpenAI

            api_key = config.llm.api_key.get_secret_value()
            llm = ChatOpenAI(
                api_key=api_key,
                base_url=config.llm.base_url,
                model=config.kg.extract_model,
                temperature=0,
                timeout=120,
                max_retries=2,
            )
            self._structured_llm = llm.with_structured_output(ExtractionResult)
            logger.info(
                "[KG_EXTRACTOR] initialized model={} ", config.kg.extract_model
            )
        return self._structured_llm

    async def extract(self, text: str, title: str = "") -> ExtractionResult:
        """抽取一个分P的实体与关系。

        text 超长时按 kg.max_text_chars 截断（成本护栏）。
        LLM 失败时抛异常，由上层标记任务失败并保留重试机会。
        """
        max_chars = config.kg.max_text_chars
        truncated = text[:max_chars]
        if len(text) > max_chars:
            logger.info(
                "[KG_EXTRACTOR] text truncated {} -> {} chars",
                len(text),
                max_chars,
            )

        user_prompt = f"视频标题：{title or '（未知）'}\n\n文字稿：\n{truncated}"
        result: ExtractionResult = await self._get_structured_llm().ainvoke(
            [
                {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ]
        )
        if not isinstance(result, ExtractionResult):
            # langchain 在部分模型上可能返回 dict
            result = ExtractionResult.model_validate(result)
        logger.info(
            "[KG_EXTRACTOR] extracted entities={} relations={}",
            len(result.entities),
            len(result.relations),
        )
        return result
