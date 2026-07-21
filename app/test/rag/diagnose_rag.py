import asyncio
from app.services.rag import RAGService
from sqlalchemy import select
from app.models import Video
from app.database import engine, get_db_context


async def diagnose() -> None:
    print("=== 正在诊断向量库状态 ===")

    rag = RAGService()

    # 1. 检查向量库统计
    if rag.vectorstore is None:
        print("[FAIL] 向量库未初始化，请检查 Milvus 配置和连接状态。")
    else:
        stats = rag.get_collection_stats()
        count = int(stats.get("total_chunks", 0))
        print(f"向量库总文档数: {count}")
        print(f"向量库视频数: {stats.get('total_videos', 0)}")
        print(f"Collection: {stats.get('collection_name', 'unknown')}")

        if count == 0:
            print(
                "[FAIL] 向量库是空的！即使你看到'知识库构建完成'，实际上并没有写入向量。"
            )
            print("可能原因：")
            print("1. 视频内容获取失败（没有字幕或摘要）")
            print("2. Embedding 调用静默失败")
        else:
            print("[OK] 向量库有数据。")

            # 2. 试着搜一下
            query = "AI"
            print(f"\n尝试搜索: '{query}'")
            try:
                results = rag.search(query, k=3)
                print(f"搜索结果数量: {len(results)}")
                for i, doc in enumerate(results):
                    print(f"--- 结果 {i+1} ---")
                    print(f"标题: {doc.metadata.get('title')}")
                    print(f"BVID: {doc.metadata.get('bvid')}")
                    print(f"内容片段: {doc.page_content[:50]}...")
            except Exception as e:
                print(f"[FAIL] 搜索报错: {e}")

    print("\n=== 检查数据库 Video ===")
    async with get_db_context() as db:
        result = await db.execute(
            select(
                Video.bvid,
                Video.cid,
                Video.page_index,
                Video.page_title,
                Video.content_source,
                Video.is_vectorized,
                Video.vector_chunk_count,
            )
        )
        videos = result.fetchall()
        print(f"视频分P数量: {len(videos)}")
        for v in videos:
            print(
                f"- [{v.bvid}] cid={v.cid} P{v.page_index + 1} "
                f"{v.page_title or ''} "
                f"(来源: {v.content_source}, 向量状态: {v.is_vectorized}, chunks: {v.vector_chunk_count})"
            )


async def main() -> None:
    try:
        await diagnose()
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
