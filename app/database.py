"""
MindBase 知识库系统

数据库管理模块
"""
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from contextlib import asynccontextmanager
from app.config import settings
from app.models import Base
import os


# 确保数据目录存在
os.makedirs("data", exist_ok=True)

# 创建异步引擎
engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
    future=True
)

# 创建异步会话工厂
async_session_factory = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False
)


async def init_db():
    """初始化数据库（创建表 + 自动迁移新列 + 种子数据）"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # 自动迁移：为已有表添加新字段（SQLite 不支持 ALTER TABLE ADD COLUMN 已存在列，故用尝试式）
    await _migrate_add_columns()

    # 种子数据：默认角色等（幂等）
    await _seed_default_data()


async def _migrate_add_columns():
    """自动迁移：为已有表添加新增的列（兼容 SQLite + MySQL）

    策略：直接执行 ALTER TABLE ADD COLUMN，捕获 Duplicate column 错误则跳过。
    避免使用 PRAGMA table_info（SQLite-only）或 INFORMATION_SCHEMA（需额外权限）。
    """
    from loguru import logger
    from sqlalchemy import text

    migrations = [
        # (table, column, type_with_default)
        ("video", "is_vectorized", "VARCHAR(20) DEFAULT 'pending'"),
        ("video", "vectorized_at", "TIMESTAMP"),
        ("video", "vector_chunk_count", "INTEGER DEFAULT 0"),
        ("video", "vector_error", "TEXT"),
        # Plan 0012: Quiz pages mode columns
        ("quiz_sets", "source_type", "VARCHAR(20) DEFAULT 'folder'"),
        ("quiz_sets", "source_pages", "TEXT"),
        # Plan 0021: session_id → uid migration
        ("user_credentials", "uid", "BIGINT DEFAULT 0"),
        ("credential_usage", "uid", "BIGINT DEFAULT 0"),
        # Plan 0021: soft-delete for user_credentials
        ("user_credentials", "deleted_at", "TIMESTAMP"),
        # Plan 0022: favorites v2 — uid-based design
        ("favorite_folders", "uid", "BIGINT"),
        ("favorite_folders", "is_default", "BOOLEAN DEFAULT FALSE"),
        ("favorite_folders", "deleted_at", "TIMESTAMP"),
        # Plan 0023: async_tasks — add uid for user scoping
        ("async_tasks", "uid", "BIGINT"),
        # Plan 0025: chat_sessions — uid-based ownership
        ("chat_sessions", "uid", "BIGINT"),
        # Plan 0026: quiz_sets — uid-based ownership
        ("quiz_sets", "uid", "BIGINT"),
        ("quiz_submissions", "uid", "BIGINT"),
        # Plan 0027: users identity fields — email/phone/password
        ("users", "email", "VARCHAR(200) UNIQUE"),
        ("users", "phone", "VARCHAR(20) UNIQUE"),
        ("users", "password_hash", "VARCHAR(255)"),
        ("users", "email_verified", "BOOLEAN DEFAULT FALSE"),
        ("users", "phone_verified", "BOOLEAN DEFAULT FALSE"),
        # Plan 0027: user_oauth — OAuth returned email
        ("user_oauth", "email", "VARCHAR(200)"),
        # Plan 0031: config tester — test status columns
        ("user_credentials", "last_test_status", "VARCHAR(20)"),
        ("user_credentials", "last_test_error", "TEXT"),
        ("user_credentials", "last_test_at", "TIMESTAMP"),
        ("user_embedding_configs", "last_test_status", "VARCHAR(20)"),
        ("user_embedding_configs", "last_test_error", "TEXT"),
        ("user_embedding_configs", "last_test_at", "TIMESTAMP"),
        ("user_asr_configs", "last_test_status", "VARCHAR(20)"),
        ("user_asr_configs", "last_test_error", "TEXT"),
        ("user_asr_configs", "last_test_at", "TIMESTAMP"),
        # Plan 0034: collection — add description and owner_mid
        ("collection", "description", "TEXT"),
        ("collection", "owner_mid", "BIGINT"),
        # Plan 0033: content_source for video
        ("video", "content_source", "VARCHAR(20)"),
        # Plan 0023: cloud_files — doc parsing & vectorization support
        ("cloud_files", "vectorizable", "BOOLEAN NOT NULL DEFAULT TRUE"),
        ("cloud_files", "doc_parser", "VARCHAR(20) NULL"),
        ("cloud_files", "doc_meta", "JSON NULL"),
        ("cloud_files", "content_hash", "VARCHAR(128) NULL"),
        # Quiz sharing — unguessable share token (separate from quiz_uuid)
        ("quiz_sets", "share_token", "VARCHAR(32)"),
        ("quiz_sets", "shared_at", "TIMESTAMP"),
        ("quiz_sets", "share_expires_at", "TIMESTAMP"),
        # Quiz quality metrics from generation (traceability_rate, dedup_rate, ...)
        ("quiz_sets", "quality_metrics", "JSON"),
        # Email verification: brute-force attempt counter + wider code column
        ("verification_codes", "attempts", "INTEGER DEFAULT 0"),
    ]

    # Column type modifications (widening VARCHAR, etc.)
    # Uses MySQL syntax MODIFY COLUMN; SQLite needs recreate-and-copy,
    # so this is best-effort and logs a warning on failure.
    modify_columns = [
        # reset tokens are ~43 chars; original VARCHAR(10) truncated them
        ("verification_codes", "code", "VARCHAR(64) NOT NULL"),
    ]
    for table, column, new_type in modify_columns:
        try:
            async with engine.begin() as conn:
                await conn.execute(
                    text(f"ALTER TABLE {table} MODIFY COLUMN {column} {new_type}")
                )
                logger.info(
                    f"[MIGRATION] Modified column {table}.{column} -> {new_type}"
                )
        except Exception as e:
            err_msg = str(e).lower()
            if "modify" in err_msg or "syntax" in err_msg:
                # SQLite doesn't support MODIFY COLUMN; skip silently.
                logger.debug(
                    f"[MIGRATION] MODIFY COLUMN not supported here, skipping {table}.{column}"
                )
            else:
                logger.warning(
                    f"[MIGRATION] Could not modify {table}.{column}: {e}"
                )

    # Plan 0024/0025/0026: drop deprecated content columns & session_id columns
    drop_columns = [
        ("video", "content"),
        ("video_versions", "content"),
        ("chat_sessions", "session_id"),
        ("credential_usage", "session_id"),
        ("quiz_sets", "session_id"),
        ("quiz_submissions", "session_id"),
    ]
    for table, column in drop_columns:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(f"ALTER TABLE {table} DROP COLUMN {column}"))
                logger.info(f"[MIGRATION] Dropped column {table}.{column}")
        except Exception as e:
            err_msg = str(e).lower()
            if "can't drop" in err_msg or "doesn't exist" in err_msg or "1091" in str(e):
                logger.debug(f"[MIGRATION] Column {table}.{column} already dropped, skipping")
            else:
                logger.warning(f"[MIGRATION] Could not drop {table}.{column}: {e}")

    # Plan 0025/0026: drop deprecated tables
    drop_tables = [
        "chat_messages",         # → MongoDB
        "quiz_questions",        # → MongoDB
        "user_sessions",         # → user_tokens (Plan 0020)
        "user_settings",         # → user_credentials (Plan 0021)
        "video_pages",           # → video (Plan 0034)
        "video_page_versions",   # → video_versions (Plan 0034)
        "video_cache",           # → collection (Plan 0034)
        "favorite_videos",       # → collection (Plan 0034)
    ]
    for table in drop_tables:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
                logger.info(f"[MIGRATION] Dropped table {table}")
        except Exception as e:
            logger.warning(f"[MIGRATION] Could not drop table {table}: {e}")

    # New table creation (CREATE TABLE IF NOT EXISTS)
    new_tables = [
        # Plan 0023: arc_meta — structured video metadata
        (
            "arc_meta",
            """CREATE TABLE IF NOT EXISTS arc_meta (
                id INT AUTO_INCREMENT PRIMARY KEY,
                video_id INT NOT NULL UNIQUE,
                summary TEXT,
                keywords JSON,
                topics JSON,
                difficulty VARCHAR(20),
                word_count INT DEFAULT 0,
                reading_time INT DEFAULT 0,
                language VARCHAR(10),
                has_code BOOLEAN DEFAULT FALSE,
                has_math BOOLEAN DEFAULT FALSE,
                is_tutorial BOOLEAN DEFAULT FALSE,
                user_tags JSON,
                notes TEXT,
                extracted_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (video_id) REFERENCES video(id) ON DELETE CASCADE
            )""",
        ),
        # Plan 0022: collection — favorites sync metadata (keyed by media_id + bvid)
        (
            "collection",
            """CREATE TABLE IF NOT EXISTS collection (
                id INT AUTO_INCREMENT PRIMARY KEY,
                media_id BIGINT NOT NULL,
                bvid VARCHAR(20) NOT NULL,
                cid BIGINT,
                title VARCHAR(500) NOT NULL,
                cover VARCHAR(500),
                duration INT,
                owner_name VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (media_id, bvid)
            )""",
        ),
        # Plan 0027: verification_codes — email/phone verification
        (
            "verification_codes",
            """CREATE TABLE IF NOT EXISTS verification_codes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                uid BIGINT NOT NULL,
                target VARCHAR(200) NOT NULL,
                type VARCHAR(20) NOT NULL,
                purpose VARCHAR(32) NOT NULL,
                code VARCHAR(64) NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                used BOOLEAN DEFAULT FALSE,
                attempts INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_vc_target_purpose (target, purpose),
                INDEX idx_vc_uid (uid),
                FOREIGN KEY (uid) REFERENCES users(uid)
            )""",
        ),
        # Plan 0028: login_attempts — login audit + brute-force cooldown
        (
            "login_attempts",
            """CREATE TABLE IF NOT EXISTS login_attempts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                uid BIGINT NULL,
                email VARCHAR(200) NULL,
                ip VARCHAR(64) NOT NULL,
                device_id VARCHAR(64) NULL,
                success BOOLEAN NOT NULL DEFAULT FALSE,
                failure_reason VARCHAR(100) NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_la_ip_created (ip, created_at),
                INDEX idx_la_email_created (email, created_at),
                INDEX idx_la_uid_created (uid, created_at)
            )""",
        ),
        # Plan 0021: Cloud Drive — folder tree
        (
            "cloud_folders",
            """CREATE TABLE IF NOT EXISTS cloud_folders (
                id INT AUTO_INCREMENT PRIMARY KEY,
                uid BIGINT NOT NULL,
                parent_id INT,
                name VARCHAR(200) NOT NULL,
                video_count INT DEFAULT 0,
                sort_order INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                deleted_at TIMESTAMP,
                FOREIGN KEY (uid) REFERENCES users(uid),
                FOREIGN KEY (parent_id) REFERENCES cloud_folders(id)
            )""",
        ),
        # Plan 0021: Cloud Drive — uploaded file metadata
        (
            "cloud_files",
            """CREATE TABLE IF NOT EXISTS cloud_files (
                id INT AUTO_INCREMENT PRIMARY KEY,
                upload_uuid VARCHAR(64) NOT NULL UNIQUE,
                uid BIGINT NOT NULL,
                folder_id INT,
                original_name VARCHAR(500) NOT NULL,
                file_size BIGINT NOT NULL,
                mime_type VARCHAR(50) NOT NULL,
                duration INT,
                bucket VARCHAR(64) NOT NULL,
                object_key VARCHAR(500) NOT NULL,
                etag VARCHAR(64),
                upload_status VARCHAR(20) DEFAULT 'uploading',
                asr_status VARCHAR(20) DEFAULT 'pending',
                vector_status VARCHAR(20) DEFAULT 'pending',
                vector_chunk_count INT DEFAULT 0,
                title VARCHAR(500),
                description TEXT,
                cover_url VARCHAR(500),
                tags JSON,
                vectorizable BOOLEAN NOT NULL DEFAULT TRUE,
                doc_parser VARCHAR(20),
                doc_meta JSON,
                content_hash VARCHAR(128),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                deleted_at TIMESTAMP,
                FOREIGN KEY (uid) REFERENCES users(uid),
                FOREIGN KEY (folder_id) REFERENCES cloud_folders(id)
            )""",
        ),
        # Plan 0021: Cloud Drive — resumable upload chunk tracking
        (
            "cloud_upload_chunks",
            """CREATE TABLE IF NOT EXISTS cloud_upload_chunks (
                id INT AUTO_INCREMENT PRIMARY KEY,
                upload_uuid VARCHAR(64) NOT NULL,
                chunk_index INT NOT NULL,
                chunk_size BIGINT NOT NULL,
                minio_upload_id VARCHAR(128),
                upload_url TEXT,
                upload_status VARCHAR(20) DEFAULT 'pending',
                etag VARCHAR(64),
                retry_count INT DEFAULT 0,
                last_heartbeat TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (upload_uuid, chunk_index)
            )""",
        ),
        # Plan 0021: Cloud Drive — upload session grouping
        (
            "cloud_upload_sessions",
            """CREATE TABLE IF NOT EXISTS cloud_upload_sessions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                session_uuid VARCHAR(64) NOT NULL UNIQUE,
                uid BIGINT NOT NULL,
                minio_upload_id VARCHAR(128),
                total_files INT DEFAULT 1,
                completed_files INT DEFAULT 0,
                status VARCHAR(20) DEFAULT 'active',
                last_heartbeat TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (uid) REFERENCES users(uid)
            )""",
        ),
        # Plan 0023: Cloud Drive — user workspaces
        (
            "workspaces",
            """CREATE TABLE IF NOT EXISTS workspaces (
                id INT AUTO_INCREMENT PRIMARY KEY,
                uid BIGINT NOT NULL,
                name VARCHAR(200) NOT NULL,
                description TEXT,
                icon VARCHAR(50),
                color VARCHAR(20),
                file_count INT DEFAULT 0,
                chunk_count INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                deleted_at TIMESTAMP,
                FOREIGN KEY (uid) REFERENCES users(uid),
                INDEX ix_workspaces_uid (uid),
                INDEX ix_workspaces_active (uid, deleted_at)
            )""",
        ),
        # Plan 0023: Cloud Drive — workspace-to-file/folder bindings
        (
            "workspace_bindings",
            """CREATE TABLE IF NOT EXISTS workspace_bindings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                workspace_id INT NOT NULL,
                uid BIGINT NOT NULL,
                bind_type VARCHAR(10) NOT NULL,
                folder_id INT,
                upload_uuid VARCHAR(64),
                include_subfolders BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
                FOREIGN KEY (uid) REFERENCES users(uid),
                FOREIGN KEY (folder_id) REFERENCES cloud_folders(id),
                INDEX ix_wb_workspace (workspace_id),
                INDEX ix_wb_uid (uid),
                INDEX ix_wb_folder (folder_id),
                INDEX ix_wb_upload_uuid (upload_uuid)
            )""",
        ),
    ]

    # Tables that need schema recreation (DROP + CREATE) because the old schema
    # is incompatible. Only executed when the old table has the wrong structure.
    recreate_tables = {
        "collection": (
            "bvid",  # old unique key column — if missing, table needs recreation
            """CREATE TABLE collection (
                id INT AUTO_INCREMENT PRIMARY KEY,
                media_id BIGINT NOT NULL,
                bvid VARCHAR(20) NOT NULL,
                cid BIGINT,
                title VARCHAR(500) NOT NULL,
                cover VARCHAR(500),
                duration INT,
                owner_name VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (media_id, bvid)
            )""",
        ),
    }

    for _name, ddl in new_tables:
        try:
            async with engine.begin() as conn:
                # If this table is in recreate_tables, check old schema first
                if _name in recreate_tables:
                    check_col, create_ddl = recreate_tables[_name]
                    try:
                        await conn.execute(text(f"SELECT {check_col} FROM {_name} LIMIT 1"))
                    except Exception:
                        # Column doesn't exist or table has wrong schema — recreate
                        logger.info(f"[MIGRATION] Recreating table {_name} (schema mismatch)")
                        await conn.execute(text(f"DROP TABLE IF EXISTS {_name}"))
                        await conn.execute(text(create_ddl))
                        logger.info(f"[MIGRATION] Recreated table {_name}")
                        continue

                await conn.execute(text(ddl))
                logger.info(f"[MIGRATION] Created table {_name}")
        except Exception as e:
            err_msg = str(e).lower()
            if "already exists" in err_msg or "1050" in str(e):
                logger.debug(f"[MIGRATION] Table {_name} already exists, skipping")
            else:
                logger.warning(f"[MIGRATION] Could not create table {_name}: {e}")

    for table, column, col_def in migrations:
        try:
            async with engine.begin() as conn:
                await conn.execute(
                    text(f"ALTER TABLE {table} ADD COLUMN {column} {col_def}")
                )
                logger.info(f"[MIGRATION] Added column {table}.{column}")
        except Exception as e:
            err_msg = str(e).lower()
            if "duplicate column" in err_msg or "already exists" in err_msg or "1060" in str(e):
                logger.debug(f"[MIGRATION] Column {table}.{column} already exists, skipping")
            else:
                logger.warning(f"[MIGRATION] Could not add {table}.{column}: {e}")

    # Column modifications (MODIFY COLUMN for existing columns, MySQL syntax).
    # PostgreSQL users: run ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL manually.
    column_mods = [
        # Plan 0022: relax NOT NULL on legacy columns for v2 compatibility
        ("favorite_folders", "session_id", "VARCHAR(64) NULL"),
        # Plan 0022: widen columns for Bilibili 64-bit IDs
        ("favorite_folders", "media_id", "BIGINT NOT NULL"),
        ("favorite_folders", "fid", "BIGINT"),
        ("video", "cid", "BIGINT NOT NULL"),
        ("video_versions", "cid", "BIGINT"),
        # Plan 0034: enforce NOT NULL for uid FKs
        ("credential_usage", "uid", "BIGINT NOT NULL"),
        ("chat_sessions", "uid", "BIGINT NOT NULL"),
    ]

    for table, column, col_def in column_mods:
        try:
            async with engine.begin() as conn:
                await conn.execute(
                    text(f"ALTER TABLE {table} MODIFY COLUMN {column} {col_def}")
                )
                logger.info(f"[MIGRATION] Modified column {table}.{column}")
        except Exception as e:
            err_msg = str(e).lower()
            if "duplicate" in err_msg or "already" in err_msg or "1060" in str(e):
                logger.debug(f"[MIGRATION] Column {table}.{column} already modified, skipping")
            else:
                logger.warning(f"[MIGRATION] Could not modify {table}.{column}: {e}")

    # Unique index on quiz_sets.share_token — separate from the column add
    # above because ALTER TABLE ADD COLUMN does not always create the index
    # on existing tables (esp. MySQL). Idempotent.
    # Try with IF NOT EXISTS first (SQLite + MySQL 8.0.29+); fall back to plain
    # CREATE UNIQUE INDEX for older MySQL where the syntax is unsupported.
    index_statements = [
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_quiz_sets_share_token ON quiz_sets (share_token)",
        "CREATE UNIQUE INDEX ix_quiz_sets_share_token ON quiz_sets (share_token)",
    ]
    index_created = False
    for stmt in index_statements:
        if index_created:
            break
        try:
            async with engine.begin() as conn:
                await conn.execute(text(stmt))
            logger.info("[MIGRATION] Index ensured: ix_quiz_sets_share_token")
            index_created = True
        except Exception as e:
            err_msg = str(e).lower()
            if "already exists" in err_msg or "1061" in str(e):
                logger.debug("[MIGRATION] Index ix_quiz_sets_share_token already exists, skipping")
                index_created = True
            elif "syntax" in err_msg or "1064" in str(e):
                # Unsupported IF NOT EXISTS syntax — try the next statement form.
                logger.debug(f"[MIGRATION] Statement form unsupported, trying fallback: {stmt}")
                continue
            else:
                logger.warning(f"[MIGRATION] Could not create index ix_quiz_sets_share_token: {e}")


async def _seed_default_data():
    """Insert system default data (idempotent, delegated to RbacRepository)."""
    from app.repository.rbac_repository import get_rbac_repository
    async with async_session_factory() as session:
        await get_rbac_repository().seed_defaults(session)


async def get_user_service():
    """FastAPI dependency: return an UserService instance for the request."""
    from app.services.auth import UserService
    from app.utils.snowflake import get_snowflake

    sf = await get_snowflake()
    async with async_session_factory() as session:
        try:
            yield UserService(session, sf)
        finally:
            await session.close()


async def get_db() -> AsyncSession:
    """获取数据库会话（用于 FastAPI 依赖注入）"""
    async with async_session_factory() as session:
        try:
            yield session
        finally:
            await session.close()


@asynccontextmanager
async def get_db_context():
    """获取数据库会话（用于上下文管理器）"""
    async with async_session_factory() as session:
        try:
            yield session
        finally:
            await session.close()
