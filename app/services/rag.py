"""
Bilibili RAG 知识库系统

RAG 服务模块 - 向量存储与问答
"""
from typing import List, Optional, TYPE_CHECKING
from loguru import logger
from langchain_openai import OpenAIEmbeddings, ChatOpenAI
from langchain_core.documents import Document
from langchain_core.messages import SystemMessage, HumanMessage
from app.config import settings
from app.response.knowledge import VideoContent
from app.services.rag.chunking import SemanticChunker
from app.services.rag.prompts import (
    qa_system_prompt,
    fallback_system_prompt,
    summary_system_prompt,
)

if TYPE_CHECKING:
    from app.services.llm.api_key_manager import ApiKeyManager
    from app.infra.vector_store import VectorStoreBackend


class RAGService:
    """RAG service — vector storage, retrieval, and QA.

    Uses a swappable VectorStoreBackend (ChromaDB default, Milvus optional).
    """

    def __init__(
        self,
        collection_name: str = "bilibili_videos",
        api_key_manager: Optional["ApiKeyManager"] = None,
        backend: Optional["VectorStoreBackend"] = None,
    ):
        self.collection_name = collection_name
        self._api_key_manager = api_key_manager

        # Embeddings
        default_embedding_api_key = settings.openai_api_key
        default_embedding_base_url = settings.openai_base_url
        default_embedding_model = settings.embedding_model

        if api_key_manager and api_key_manager.is_enabled:
            from app.services.llm.dynamic_embeddings import DynamicEmbeddings
            self.embeddings = DynamicEmbeddings(
                api_key_manager,
                api_key=default_embedding_api_key,
                base_url=default_embedding_base_url,
                model=default_embedding_model,
            )
        else:
            try:
                from langchain_community.embeddings import DashScopeEmbeddings
                self.embeddings = DashScopeEmbeddings(
                    dashscope_api_key=default_embedding_api_key,
                    model=default_embedding_model,
                )
            except ImportError:
                self.embeddings = OpenAIEmbeddings(
                    api_key=default_embedding_api_key,
                    base_url=default_embedding_base_url,
                    model=default_embedding_model,
                    check_embedding_ctx_length=False,
                )

        # Vector store backend (swappable via config)
        if backend:
            self.backend = backend
        else:
            from app.infra.vector_store import get_vector_store
            self.backend = get_vector_store(self.embeddings)

        # Cloud drive vector backend (Plan 0023: separate Milvus collection)
        self.cloud_backend = None
        try:
            from app.infra.config import config
            if config.milvus.enabled:
                from app.infra.vector_store import get_cloud_vector_store
                self.cloud_backend = get_cloud_vector_store(self.embeddings)
                logger.info("[RAG] cloud_backend initialized: %s", config.milvus.cloud_collection_name)
        except Exception as e:
            logger.warning("[RAG] cloud_backend init failed: %s", e)

        # LLM (default, chat.py creates per-request LLM dynamically)
        self.llm = ChatOpenAI(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url,
            model=settings.llm_model,
            temperature=0.5,
        )

        # Semantic chunker
        self.chunker = SemanticChunker(
            target_size=getattr(settings, "chunk_target_size", 750),
            min_size=getattr(settings, "chunk_min_size", 300),
            max_size=getattr(settings, "chunk_max_size", 900),
            overlap=getattr(settings, "chunk_overlap", 100),
        )

    def add_video_content(
        self,
        video: VideoContent,
        page_index: int = 0,
        page_title: Optional[str] = None,
    ) -> int:
        """Add a single video's content chunks to the vector store."""
        title = video.title or "untitled"
        content_parts: List[str] = []

        if video.content and video.content.strip():
            content_parts.append(video.content.strip())

        if video.outline:
            outline_text = "\n## 内容提纲\n"
            for item in video.outline:
                item_title = item.get('title', '') or ''
                outline_text += f"\n### {item_title}\n"
                for point in item.get("points", []):
                    point_content = point.get('content', '') or ''
                    if point_content:
                        outline_text += f"- {point_content}\n"
            if outline_text.strip() != "## 内容提纲":
                content_parts.append(outline_text)

        full_content = "\n\n".join(content_parts).strip()

        if not full_content or len(full_content.strip()) < 10:
            logger.warning(f"[{video.bvid}] content too short, skipping")
            return 0

        chunk_results = self.chunker.chunk(
            text=full_content,
            video_title=title,
            page_title=page_title or title,
            outline=video.outline,
        )

        if not chunk_results:
            logger.warning(f"[{video.bvid}] no valid chunks after semantic chunking")
            return 0

        chunk_lengths = [len(c.display_text) for c in chunk_results]
        logger.info(
            f"[VECTORIZE_TRACE] bvid={video.bvid} page={page_index} "
            f"raw_len={len(full_content)} chunk_count={len(chunk_results)} "
            f"avg_len={sum(chunk_lengths)//max(len(chunk_lengths),1)} "
            f"min_len={min(chunk_lengths)} max_len={max(chunk_lengths)} "
            f"has_outline={bool(video.outline)}"
        )

        embedding_version = getattr(settings, "embedding_version", "v1")
        documents = []
        for i, result in enumerate(chunk_results):
            chunk_id = f"{video.bvid}:{page_index}:{i}"
            doc = Document(
                page_content=result.embedding_text,
                metadata={
                    "bvid": video.bvid,
                    "title": title,
                    "page_index": page_index,
                    "page_title": page_title or title,
                    "source": video.source.value,
                    "chunk_index": i,
                    "chunk_id": chunk_id,
                    "section_title": result.section_title or "",
                    "content_type": result.content_type,
                    "embedding_version": embedding_version,
                    "url": f"https://www.bilibili.com/video/{video.bvid}?p={page_index + 1}",
                }
            )
            documents.append(doc)

        try:
            self.backend.add(documents)
            logger.info(
                f"[VECTORIZE_TRACE] bvid={video.bvid} page={page_index} "
                f"write_success=True chunks_written={len(documents)} "
                f"embedding_model={settings.embedding_model}"
            )
        except Exception as e:
            logger.error(
                f"[VECTORIZE_TRACE] bvid={video.bvid} page={page_index} "
                f"write_success=False error={e}"
            )
            raise

        return len(documents)

    def add_videos_batch(self, videos: List[VideoContent], progress_callback=None) -> dict:
        """Batch-add videos to vector store."""
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
                logger.error(f"Failed to add video [{video.bvid}]: {e}")
                failed += 1

        return {"success": success, "failed": failed, "chunks": total_chunks}

    def search(
        self,
        query: str,
        k: int = 5,
        bvids: Optional[List[str]] = None,
        workspace_pages: Optional[List[dict]] = None,
    ) -> List[Document]:
        """Semantic search with optional filters."""
        if not query or not query.strip():
            return []

        try:
            filter_cond: dict | None = None
            if workspace_pages:
                wp_bvids = list(set(wp.get("bvid") for wp in workspace_pages))
                filter_cond = {"bvid": {"$in": wp_bvids}}
            elif bvids:
                filter_cond = {"bvid": {"$in": bvids}}

            docs = self.backend.search(query, k=k, filter=filter_cond)

            # Workspace mode: further filter by exact page_index
            if workspace_pages:
                wp_set = {(wp.get("bvid"), wp.get("page_index", 0)) for wp in workspace_pages}
                docs = [d for d in docs if (d.metadata.get("bvid"), d.metadata.get("page_index", 0)) in wp_set]

            logger.info(f"Search done: query='{query}' results={len(docs)}")
            return docs
        except Exception as e:
            logger.warning(f"Vector search failed: {e}")
            return []

    async def _fallback_answer(self, question: str, reason: str = "", context: str = "") -> dict:
        """Answer without retrieved context."""
        try:
            system_prompt = fallback_system_prompt(context=context, reason=reason)
            messages = [
                SystemMessage(content=system_prompt),
                HumanMessage(content=question),
            ]
            response = await self.llm.ainvoke(messages)
            return {"answer": str(response.content or "").strip(), "sources": []}
        except Exception as e:
            logger.error(f"Fallback failed: {e}")
            return {"answer": f"Sorry, {reason}. Try building more content or rephrasing.", "sources": []}

    async def answer_question(self, question: str, k: int = 5, bvids: Optional[List[str]] = None) -> dict:
        """Answer a question using RAG."""
        stats = self.get_collection_stats()
        if stats["total_chunks"] == 0:
            return await self._fallback_answer(question, "knowledge base is empty")

        try:
            docs = self.search(question, k=k, bvids=bvids if bvids else None)
        except Exception as e:
            logger.error(f"Search failed: {e}")
            return await self._fallback_answer(question, "search encountered an error")

        if not docs:
            return await self._fallback_answer(question, "no relevant content found")

        context_parts = []
        seen_bvids = set()
        sources = []

        for doc in docs:
            bvid = doc.metadata.get("bvid", "")
            title = doc.metadata.get("title", "untitled")
            content = doc.page_content.strip()
            if not content:
                continue
            if not content.startswith(title):
                content = f"【{title}】\n{content}"
            context_parts.append(content)
            if bvid and bvid not in seen_bvids:
                seen_bvids.add(bvid)
                sources.append({
                    "bvid": bvid,
                    "title": title,
                    "url": doc.metadata.get("url", f"https://www.bilibili.com/video/{bvid}")
                })

        if not context_parts:
            return {"answer": "Found videos but no usable text content.", "sources": sources}

        context = "\n\n---\n\n".join(context_parts)
        if not context.strip():
            return {"answer": "No usable content to answer your question.", "sources": sources}

        try:
            system_prompt = qa_system_prompt(context)
            messages = [
                SystemMessage(content=system_prompt),
                HumanMessage(content=question),
            ]
            response = await self.llm.ainvoke(messages)
            return {"answer": str(response.content or "").strip(), "sources": sources}
        except Exception as e:
            logger.error(f"LLM call failed: {e}")
            return {"answer": f"AI error: {str(e)}", "sources": sources}

    async def summarize_content(self, content: str) -> str:
        """Summarize content using LLM."""
        max_length = 10000
        if len(content) > max_length:
            content = content[:max_length] + "\n...(truncated)"

        system_prompt = summary_system_prompt()
        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=content),
        ]
        response = await self.llm.ainvoke(messages)
        return str(response.content or "").strip()

    def get_collection_stats(self) -> dict:
        """Get vector store statistics."""
        return self.backend.get_stats()

    def clear_collection(self):
        """Clear all vectors."""
        self.backend.clear()

    def delete_video(self, bvid: str):
        """Delete all chunks for a video."""
        self.backend.delete_by_bvid(bvid)
        logger.info(f"Deleted video: {bvid}")

    def delete_page_vectors(self, bvid: str, page_index: int):
        """Delete all chunks for a page within a video."""
        self.backend.delete_by_page(bvid, page_index)
        logger.info(f"Deleted page vectors: {bvid} P{page_index + 1}")

    def get_page_vector_count(self, bvid: str, page_index: int) -> int:
        """Count chunks for a page within a video."""
        return self.backend.count_by_page(bvid, page_index)
