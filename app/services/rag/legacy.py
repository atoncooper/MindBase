"""
Bilibili RAG 知识库系统

RAG 服务模块 - 向量存储与问答
"""

from datetime import datetime, timezone, timedelta
import re
from typing import List, Optional, TYPE_CHECKING
from loguru import logger
from langchain_openai import OpenAIEmbeddings, ChatOpenAI
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_core.documents import Document
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnablePassthrough
from langchain_core.output_parsers import StrOutputParser
from app.config import settings
from app.response.knowledge import VideoContent

if TYPE_CHECKING:
    from app.services.llm.api_key_manager import ApiKeyManager


_FILENAME_RE = re.compile(
    r"(?P<name>\S+\.(?:md|markdown|docx?|pdf|txt|pptx?|xlsx?|csv|json|py|js|ts|html?|rst|tex|yaml|yml|toml|ini|cfg|conf|sh|bash|zsh|go|java|c|cpp|h|rs|rb|php|sql|r|swift|kt))",
    re.IGNORECASE,
)


def _extract_filenames(query: str) -> list[str]:
    """Extract filenames (with extensions) from a user query."""
    return [m.group("name") for m in _FILENAME_RE.finditer(query)]


class RAGService:
    """
    RAG 服务

    负责：
    1. 向量存储管理
    2. 文档添加与检索
    3. 问答功能

    支持用户自定义 API Key（通过 ApiKeyManager + DynamicEmbeddings）。
    """

    def __init__(
        self,
        collection_name: str = "bilibili_videos",
        api_key_manager: Optional["ApiKeyManager"] = None,
    ):
        """
        初始化 RAG 服务

        Args:
            collection_name: 向量集合名称
            api_key_manager: 用户 API Key 管理器（可选，支持动态 Embedding Key）
        """
        self.collection_name = collection_name
        self._api_key_manager = api_key_manager

        # 默认配置
        default_embedding_api_key = settings.openai_api_key
        default_embedding_base_url = settings.openai_base_url
        default_embedding_model = settings.embedding_model

        # 初始化 Embeddings
        if api_key_manager and api_key_manager.is_enabled:
            from app.services.llm.dynamic_embeddings import DynamicEmbeddings

            self.embeddings = DynamicEmbeddings(
                api_key_manager,
                api_key=default_embedding_api_key,
                base_url=default_embedding_base_url,
                model=default_embedding_model,
            )
            logger.info("使用 DynamicEmbeddings 初始化（支持用户自定义 Embedding Key）")
        else:
            # 无 ApiKeyManager 时使用默认 Embeddings（兼容现有逻辑）
            try:
                from langchain_community.embeddings import DashScopeEmbeddings

                self.embeddings = DashScopeEmbeddings(
                    dashscope_api_key=default_embedding_api_key,
                    model=default_embedding_model,
                )
                logger.info("使用 DashScopeEmbeddings 初始化成功")
            except ImportError:
                self.embeddings = OpenAIEmbeddings(
                    api_key=default_embedding_api_key,
                    base_url=default_embedding_base_url,
                    model=default_embedding_model,
                    check_embedding_ctx_length=False,
                )

        # 初始化向量存储 — 统一使用 Milvus
        self.vectorstore = None
        self.cloud_backend = None

        from app.infra.config import config

        if not config.milvus.enabled:
            logger.warning("[RAG] Milvus not enabled, vector store unavailable")
        else:
            from app.repository.vector_store_milvus import MilvusVectorStore

            # Auto-detect actual embedding dimension
            test_vec = self.embeddings.embed_query("dim-probe")
            actual_dim = len(test_vec)
            logger.info(
                "[RAG] detected embedding dim={} (config says {})",
                actual_dim,
                config.milvus.dimension,
            )
            config.milvus.dimension = actual_dim

            # B站 video store (bilibili_videos)
            try:
                self.vectorstore = MilvusVectorStore(
                    config.milvus,
                    self.embeddings,
                    config.milvus.collection_name,
                )
                logger.info(
                    "[RAG] vectorstore initialized: {}", config.milvus.collection_name
                )
            except Exception as e:
                logger.warning(
                    "[RAG] vectorstore init failed: error_type={}",
                    type(e).__name__,
                )

            # Cloud drive store (cloud_drive) — independent try/except
            try:
                from app.infra.vector_store import get_cloud_vector_store

                self.cloud_backend = get_cloud_vector_store(self.embeddings)
                logger.info(
                    "[RAG] cloud_backend initialized: {}",
                    config.milvus.cloud_collection_name,
                )
            except Exception as e:
                logger.warning(
                    "[RAG] cloud_backend init failed: error_type={}",
                    type(e).__name__,
                )

        # 初始化 LLM
        self.llm = ChatOpenAI(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url,
            model=settings.llm_model,
            temperature=0.5,
        )

        # 文本分割器
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000,
            chunk_overlap=200,
            separators=["\n\n", "\n", "。", "！", "？", ".", "!", "?", " "],
        )

        # 问答提示模板
        self.qa_prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    """你是一个知识库助手，专门基于用户收藏的 B站视频内容来回答问题。

请遵循以下规则：
1. 根据提供的视频内容来回答问题
2. 回答要自然、友好、有条理
3. 可以引用相关的视频标题作为来源
4. 如果多个视频涉及相同话题，请综合它们的内容

视频内容：
{context}
""",
                ),
                ("human", "{question}"),
            ]
        )

        # 无内容时的通用回复模板
        self.fallback_prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    """你是一个友好的助手。用户在使用一个B站收藏夹知识库系统。

当前情况：知识库中没有找到与用户问题相关的内容。

请：
1. 友好地回应用户的问题
2. 如果能根据常识简单回答，可以简要回答
3. 建议用户构建更多收藏夹内容，或者换个问法
4. 保持自然、不要死板
""",
                ),
                ("human", "{question}"),
            ]
        )

        # 摘要提示模板
        self.summary_prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    """你是一个内容总结专家。请对以下视频字幕内容进行总结。

要求：
1. 提取核心要点（3-5个）
2. 生成一段简洁的总结（100-200字）
3. 保持原意，不要添加额外信息

字幕内容：""",
                ),
                ("human", "{content}"),
            ]
        )

    def add_video_content(
        self,
        video: VideoContent,
        page_index: int = 0,
        page_title: Optional[str] = None,
    ) -> int:
        """
        添加单个视频内容到向量库

        Args:
            video: VideoContent 对象
            page_index: 分P序号（0-based），默认 0
            page_title: 分P标题，默认 None

        Returns:
            添加的文档块数量
        """
        # 构建完整内容（正文不带标题，避免标题相似度主导召回）
        title = video.title or "未知标题"
        content_parts: List[str] = []

        if video.content and video.content.strip():
            content_parts.append(video.content.strip())

        # 如果有分段提纲，添加结构化信息
        if video.outline:
            outline_text = "\n## 内容提纲\n"
            for item in video.outline:
                item_title = item.get("title", "") or ""
                outline_text += f"\n### {item_title}\n"
                for point in item.get("points", []):
                    point_content = point.get("content", "") or ""
                    if point_content:
                        outline_text += f"- {point_content}\n"
            if outline_text.strip() != "## 内容提纲":
                content_parts.append(outline_text)

        full_content = "\n\n".join(content_parts).strip()

        # 验证内容不为空
        if not full_content or len(full_content.strip()) < 10:
            logger.warning("内容太少，跳过: bvid_present={}", bool(video.bvid))
            return 0

        # 分块
        chunks = self.text_splitter.split_text(full_content)

        if not chunks:
            logger.warning("没有生成文档块: bvid_present={}", bool(video.bvid))
            return 0

        # 过滤空内容块
        valid_chunks = [c for c in chunks if c and c.strip() and len(c.strip()) > 5]
        if not valid_chunks:
            logger.warning("没有有效的文档块: bvid_present={}", bool(video.bvid))
            return 0

        # 创建文档
        documents = []
        for i, chunk in enumerate(valid_chunks):
            doc = Document(
                page_content=chunk.strip(),  # 确保是干净的字符串
                metadata={
                    "bvid": video.bvid,
                    "title": title,
                    "page_index": page_index,
                    "page_title": page_title or title,
                    "source": video.source.value,
                    "chunk_index": i,
                    "url": f"https://www.bilibili.com/video/{video.bvid}?p={page_index + 1}",
                },
            )
            documents.append(doc)

        # 幂等性：先删除该页面的旧向量（避免重复写入）
        try:
            self.delete_page_vectors(video.bvid, page_index)
            count = self.vectorstore.add(
                documents, partition_dt=datetime.now(timezone.utc)
            )
            logger.info(
                "视频内容添加完成: bvid_present={} chunks={}",
                bool(video.bvid),
                count,
            )
        except Exception as e:
            logger.error(
                "添加到向量库失败: bvid_present={} error_type={}",
                bool(video.bvid),
                type(e).__name__,
            )
            raise

        return len(documents)

    def add_videos_batch(
        self, videos: List[VideoContent], progress_callback=None
    ) -> dict:
        """
        批量添加视频到向量库

        Args:
            videos: VideoContent 列表
            progress_callback: 进度回调 callback(current, total, title)

        Returns:
            {"success": 成功数, "failed": 失败数, "chunks": 总块数}
        """
        success = 0
        failed = 0
        total_chunks = 0

        for i, video in enumerate(videos):
            try:
                chunks = self.add_video_content(video)
                total_chunks += chunks
                success += 1

                if progress_callback:
                    progress_callback(i + 1, len(videos), video.title)

            except Exception as e:
                logger.error(
                    "添加视频失败: bvid_present={} error_type={}",
                    bool(video.bvid),
                    type(e).__name__,
                )
                failed += 1

        return {"success": success, "failed": failed, "chunks": total_chunks}

    def search(
        self,
        query: str,
        k: int = 5,
        bvids: Optional[List[str]] = None,
        workspace_pages: Optional[List[dict]] = None,
        uid: Optional[int] = None,
        partition_start: Optional[datetime] = None,
        partition_end: Optional[datetime] = None,
        upload_uuids: Optional[List[str]] = None,
    ) -> List[Document]:
        """
        检索相关内容

        Args:
            query: 查询文本
            k: 召回数量
            bvids: 可选，限制在这些视频范围内搜索
            workspace_pages: 可选，工作区选中的分P列表，用于精确过滤。
                             格式: [{"bvid": "BVxxx", "cid": 123, "page_index": 0}, ...]
            uid: 可选，用户 ID，用于云盘搜索时隔离数据
            partition_start: 可选，分区起始日期，默认最近12个月
            partition_end: 可选，分区结束日期
        """
        if not query or not query.strip():
            logger.warning("检索查询为空")
            return []

        # Default partition range: last 12 months
        if partition_start is None:
            partition_start = datetime.now(timezone.utc) - timedelta(days=365)
        if partition_end is None:
            partition_end = datetime.now(timezone.utc)

        try:
            # 构建过滤条件
            filter_cond = None
            filenames = _extract_filenames(query)
            if filenames:
                logger.info(
                    "[RAG] detected filenames in query: count={}", len(filenames)
                )

            if workspace_pages:
                # 工作区模式：精确匹配 bvid + page_index
                conditions = []
                for wp in workspace_pages:
                    bvid_val = wp.get("bvid")
                    page_idx = wp.get("page_index", 0)
                    # 诊断：检查是否有异常类型
                    if not isinstance(bvid_val, str):
                        logger.warning(
                            "[RAG_SEARCH_DEBUG] workspace_pages 中 bvid 类型异常: type={}",
                            type(bvid_val).__name__,
                        )
                    if not isinstance(page_idx, int):
                        logger.warning(
                            "[RAG_SEARCH_DEBUG] workspace_pages 中 page_index 类型异常: type={}",
                            type(page_idx).__name__,
                        )
                    conditions.append({"bvid": bvid_val, "page_index": page_idx})
                if conditions:
                    # Milvus $or is not yet needed — simplified bvid $in filter
                    # 这里用简化的方式：先用 bvids 过滤，再在结果中过滤 page_index
                    try:
                        wp_bvids = list(set(wp.get("bvid") for wp in workspace_pages))
                    except TypeError as te:
                        logger.warning(
                            "[RAG_SEARCH_DEBUG] wp_bvids set 构建失败: error_type={}",
                            type(te).__name__,
                        )
                        raise
                    filter_cond = {"bvid": {"$in": wp_bvids}}
            elif bvids:
                filter_cond = {"bvid": {"$in": bvids}}

            # 并行搜索 Milvus bilibili_videos + cloud_drive
            from concurrent.futures import ThreadPoolExecutor

            effective_k = k

            search_kwargs = {"k": effective_k}
            if filter_cond:
                search_kwargs["filter"] = filter_cond

            with ThreadPoolExecutor(max_workers=2) as pool:
                # B站 search: only run when a scope filter is present
                # (bvids / workspace_pages).  Without a filter, full-scan
                # over all B站 videos produces too much noise — the
                # embedding space is shared with cloud docs so unrelated
                # video chunks frequently leak in.
                bilibili_fut = None
                has_bilibili_scope = bool(filter_cond) or bool(workspace_pages)
                if has_bilibili_scope and not filenames:
                    bilibili_fut = pool.submit(
                        self.vectorstore.search,
                        query,
                        partition_dt_start=partition_start,
                        partition_dt_end=partition_end,
                        **search_kwargs,
                    )
                cloud_fut = None
                if self.cloud_backend is not None:
                    cloud_filter: dict | None = (
                        {"uid": uid} if uid is not None else None
                    )
                    # Inherited scope from last turn: restrict to specific cloud docs
                    if upload_uuids:
                        if cloud_filter is None:
                            cloud_filter = {}
                        cloud_filter["upload_uuid"] = {"$in": upload_uuids}
                        logger.info(
                            "[RAG] cloud search with inherited scope: upload_uuid count={}",
                            len(upload_uuids),
                        )
                    # When query mentions a filename, restrict cloud search by title
                    if filenames:
                        if cloud_filter is None:
                            cloud_filter = {}
                        # Use like-match so "report.pdf" also matches
                        # stored titles like "/path/to/report.pdf"
                        cloud_filter["title"] = {"$like": f"%{filenames[0]}%"}
                        logger.info(
                            "[RAG] cloud search with title like-filter: filename_count={}",
                            len(filenames),
                        )
                    cloud_fut = pool.submit(
                        self.cloud_backend.search,
                        query,
                        k=effective_k,
                        filter=cloud_filter,
                    )
                else:
                    logger.error(
                        "[RAG] cloud_backend is None — cloud document search SKIPPED (Milvus not connected?)"
                    )

                docs = list(bilibili_fut.result()) if bilibili_fut else []
                if cloud_fut:
                    try:
                        cloud_docs = cloud_fut.result()
                        logger.info(
                            "[RAG] cloud_backend search: query_len={} uid_present={} → {} results",
                            len(query),
                            uid is not None,
                            len(cloud_docs),
                        )
                        docs.extend(cloud_docs)
                    except Exception as e:
                        logger.warning(
                            "[RAG] cloud_backend search skipped: error_type={}",
                            type(e).__name__,
                        )

                # When querying by filename and no results found,
                # do NOT fall back to unfiltered semantic search — it returns
                # irrelevant docs and confuses the LLM.  Instead return empty
                # so the LLM can clearly say "file not found in knowledge base".

            # 工作区模式：进一步按 page_index 精确过滤
            if workspace_pages:
                wp_set = {
                    (wp.get("bvid"), wp.get("page_index", 0)) for wp in workspace_pages
                }
                docs = [
                    d
                    for d in docs
                    if (d.metadata.get("bvid"), d.metadata.get("page_index", 0))
                    in wp_set
                ]

            # Rerank stage. Runs after merge + workspace filter so the
            # reranker sees the same candidate pool the consumer would have
            # seen — minus the k-cut. NullReranker just slices, so this is
            # safe to call unconditionally; we keep the flag check only to
            # avoid the cost when disabled.
            docs = docs[:k]

            logger.info("检索完成：query_len={}，召回={}", len(query), len(docs))
            for idx, doc in enumerate(docs):
                meta = doc.metadata or {}
                logger.info(
                    "召回[{}] source_type={} has_bvid={} has_upload_uuid={} chunk_index_present={} content_len={}",
                    idx + 1,
                    "cloud" if meta.get("upload_uuid") else "bilibili",
                    bool(meta.get("bvid")),
                    bool(meta.get("upload_uuid")),
                    meta.get("chunk_index") is not None,
                    len(doc.page_content or ""),
                )

            return docs
        except Exception as e:
            logger.warning("向量检索失败: error_type={}", type(e).__name__)
            return []

    async def _fallback_answer(self, question: str, reason: str = "") -> dict:
        """
        当没有检索到内容时，让 AI 自然回复

        Args:
            question: 用户问题
            reason: 原因说明

        Returns:
            回答结果
        """
        try:
            chain = (
                {"question": RunnablePassthrough()}
                | self.fallback_prompt
                | self.llm
                | StrOutputParser()
            )

            answer = await chain.ainvoke(question)
            return {"answer": answer, "sources": []}
        except Exception as e:
            logger.error("Fallback 回复失败: error_type={}", type(e).__name__)
            return {
                "answer": f"抱歉，{reason}。您可以尝试构建更多收藏夹内容，或者换个问法试试。",
                "sources": [],
            }

    async def answer_question(
        self, question: str, k: int = 5, bvids: Optional[List[str]] = None
    ) -> dict:
        """
        回答问题

        Args:
            question: 用户问题
            k: 检索文档数量
            bvids: 可选，限制在这些视频范围内搜索

        Returns:
            {
                "answer": 回答内容,
                "sources": 来源视频列表
            }
        """
        # 先检查向量库是否有内容
        stats = self.get_collection_stats()
        if stats["total_chunks"] == 0:
            # 知识库为空时，使用 fallback 让 AI 自然回复
            return await self._fallback_answer(question, "知识库目前还没有内容")

        # 检索相关文档
        try:
            docs = self.search(question, k=k, bvids=bvids if bvids else None)
        except Exception as e:
            logger.error("检索失败: error_type={}", type(e).__name__)
            return await self._fallback_answer(question, "检索时遇到问题")

        if not docs:
            # 没检索到内容时，也让 AI 自然回复
            return await self._fallback_answer(question, "没有找到相关内容")

        # 构建上下文
        context_parts = []
        seen_bvids = set()
        sources = []

        for doc in docs:
            bvid = doc.metadata.get("bvid", "")
            title = doc.metadata.get("title", "未知标题")
            content = doc.page_content.strip()

            if content:  # 只添加有内容的文档
                context_parts.append(f"【{title}】\n{content}")

            if bvid and bvid not in seen_bvids:
                seen_bvids.add(bvid)
                sources.append(
                    {
                        "bvid": bvid,
                        "title": title,
                        "url": doc.metadata.get(
                            "url", f"https://www.bilibili.com/video/{bvid}"
                        ),
                    }
                )

        # 如果没有有效内容
        if not context_parts:
            return {
                "answer": "检索到了相关视频，但没有找到有效的文本内容。可能是视频还未完成内容提取。",
                "sources": sources,
            }

        context = "\n\n---\n\n".join(context_parts)

        # 确保 context 不为空
        if not context.strip():
            return {"answer": "没有找到可用的内容来回答您的问题。", "sources": sources}

        # 构建链并执行
        try:
            chain = (
                {"context": lambda _: context, "question": RunnablePassthrough()}
                | self.qa_prompt
                | self.llm
                | StrOutputParser()
            )

            answer = await chain.ainvoke(question)

            return {"answer": answer, "sources": sources}
        except Exception as e:
            logger.error("LLM 调用失败: error_type={}", type(e).__name__)
            return {"answer": "AI 回答时发生错误", "sources": sources}

    async def summarize_content(self, content: str) -> str:
        """
        使用 LLM 总结内容（用于字幕内容）

        Args:
            content: 原始内容（字幕文本）

        Returns:
            总结后的内容
        """
        # 如果内容太长，先截断
        max_length = 10000
        if len(content) > max_length:
            content = content[:max_length] + "\n...(内容已截断)"

        chain = (
            {"content": RunnablePassthrough()}
            | self.summary_prompt
            | self.llm
            | StrOutputParser()
        )

        return await chain.ainvoke(content)

    def get_collection_stats(self) -> dict:
        """获取向量库统计信息"""
        try:
            return self.vectorstore.get_stats()
        except Exception as e:
            logger.error("获取统计信息失败: error_type={}", type(e).__name__)
            return {
                "total_chunks": 0,
                "total_videos": 0,
                "collection_name": self.collection_name,
            }

    def clear_collection(self):
        """清空向量库"""
        try:
            self.vectorstore.clear()
            logger.info("已清空向量库: collection={}", self.collection_name)
        except Exception as e:
            logger.error("清空向量库失败: error_type={}", type(e).__name__)
            raise

    def delete_video(self, bvid: str):
        """
        删除指定视频的所有文档块

        Args:
            bvid: 视频 BV 号
        """
        try:
            self.vectorstore.delete_by_bvid(bvid)
            logger.info("已删除视频: bvid_present={}", bool(bvid))
        except Exception as e:
            logger.error(
                "删除视频失败: bvid_present={} error_type={}",
                bool(bvid),
                type(e).__name__,
            )
            raise

    def delete_page_vectors(self, bvid: str, page_index: int):
        """
        删除指定分P的所有文档块

        Args:
            bvid: 视频 BV 号
            page_index: 分P序号（0-based）
        """
        try:
            self.vectorstore.delete_by_page(bvid, page_index)
            logger.info(
                "已删除分P向量: bvid_present={} page_index={}",
                bool(bvid),
                page_index,
            )
        except Exception as e:
            logger.error(
                "删除分P向量失败: bvid_present={} page_index={} error_type={}",
                bool(bvid),
                page_index,
                type(e).__name__,
            )
            raise

    def get_page_vector_count(self, bvid: str, page_index: int) -> int:
        """
        获取指定分P的向量块数量

        Args:
            bvid: 视频 BV 号
            page_index: 分P序号（0-based）

        Returns:
            向量块数量
        """
        try:
            return self.vectorstore.count_by_page(bvid, page_index)
        except Exception as e:
            logger.warning(
                "获取分P向量数量失败: bvid_present={} page_index={} error_type={}",
                bool(bvid),
                page_index,
                type(e).__name__,
            )
            return 0
