"""
Bilibili RAG 知识库系统

数据模型定义
"""

from sqlalchemy import (
    Column,
    Integer,
    BigInteger,
    String,
    Text,
    DateTime,
    Date,
    Boolean,
    JSON,
    Float,
    UniqueConstraint,
    ForeignKey,
    Index,
)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship
from datetime import datetime, timezone

Base = declarative_base()


# ==================== SQLAlchemy 模型 ====================


class Collection(Base):
    """Video metadata cached from Bilibili collection/favorites sync.

    Keyed by (media_id, bvid) — one row per video per collection.
    Query: SELECT * FROM collection WHERE media_id = ? — no JOIN needed.
    """

    __tablename__ = "collection"

    id = Column(Integer, primary_key=True, autoincrement=True)
    media_id = Column(BigInteger, nullable=False, index=True)  # B站 collection ID
    bvid = Column(String(20), nullable=False)
    cid = Column(BigInteger, nullable=True)
    title = Column(String(500), nullable=False)
    cover = Column(String(500), nullable=True)
    duration = Column(Integer, nullable=True)
    owner_name = Column(String(100), nullable=True)
    owner_mid = Column(BigInteger, nullable=True)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        UniqueConstraint("media_id", "bvid", name="uq_collection_media_bvid"),
    )


class FavoriteFolder(Base):
    """收藏夹记录表

    v2 (uid-based): uid + media_id 唯一确定一个收藏夹，同步时 upsert。
    session_id 保留用于旧路由（knowledge.py / chat.py）兼容。
    """

    __tablename__ = "favorite_folders"

    id = Column(Integer, primary_key=True, autoincrement=True)
    uid = Column(
        BigInteger, ForeignKey("users.uid"), nullable=True, index=True
    )  # v2: 用户 ID
    session_id = Column(
        String(64), index=True, nullable=True
    )  # 旧路由兼容，新路由可为空

    # B站收藏夹信息
    media_id = Column(BigInteger, nullable=False)  # B站收藏夹 ID（64-bit）
    fid = Column(BigInteger, nullable=True)  # deprecated
    title = Column(String(200), nullable=False)
    media_count = Column(Integer, default=0)  # 视频总数（同步时更新）
    is_default = Column(Boolean, default=False)  # v2: 是否默认收藏夹

    # 状态
    is_selected = Column(Boolean, default=True)  # 用户是否勾选用于知识库
    last_sync_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    deleted_at = Column(DateTime, nullable=True)  # v2: 软删除

    __table_args__ = (
        UniqueConstraint("uid", "media_id", name="uq_fav_folder_uid_media"),
    )


# ==================== Video & VideoVersion (分P ASR) ====================


class Video(Base):
    """Video page identified by cid — one row per episode."""

    __tablename__ = "video"

    id = Column(Integer, primary_key=True, autoincrement=True)
    bvid = Column(String(20), index=True, nullable=False)
    cid = Column(BigInteger, nullable=False)  # Bilibili cid
    page_index = Column(Integer, nullable=False)  # 0-based P序号
    page_title = Column(String(500), nullable=True)  # 如 "P1. 引言"

    # ASR text stored in MongoDB asr_documents; MySQL keeps only metadata
    content_source = Column(String(20), nullable=True)  # asr / user_edit
    is_processed = Column(Boolean, default=False)  # ASR 是否完成
    version = Column(Integer, default=1)  # 当前版本号

    # 向量化状态（v2 新增）
    is_vectorized = Column(
        String(20), default="pending"
    )  # pending / processing / done / failed
    vectorized_at = Column(DateTime, nullable=True)
    vector_chunk_count = Column(Integer, default=0)
    vector_error = Column(Text, nullable=True)

    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        UniqueConstraint("bvid", "cid", name="uq_video_bvid_cid"),
        UniqueConstraint("bvid", "page_index", name="uq_video_bvid_index"),
    )


class VideoVersion(Base):
    """ASR version history per cid."""

    __tablename__ = "video_versions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    bvid = Column(String(20), index=True, nullable=False)
    cid = Column(BigInteger, nullable=False)
    page_index = Column(Integer, nullable=False)
    version = Column(Integer, nullable=False)

    content_source = Column(String(20), nullable=True)  # asr / user_edit
    is_latest = Column(Boolean, default=False)

    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        UniqueConstraint("bvid", "cid", "version", name="uq_video_version"),
    )


class VideoMetadata(Base):
    """Structured metadata extracted from video content (1:1 with video).

    Full ASR text → MongoDB (asr_documents).  Structured insights → this table.
    video_id FK → video.id — one metadata row per video page (cid).
    """

    __tablename__ = "arc_meta"

    id = Column(Integer, primary_key=True, autoincrement=True)
    video_id = Column(
        Integer,
        ForeignKey("video.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )

    # AI-extracted
    summary = Column(Text, nullable=True)
    keywords = Column(JSON, nullable=True)  # ["keyword1", "keyword2"]
    topics = Column(JSON, nullable=True)  # [{"name": "...", "confidence": 0.9}]
    difficulty = Column(String(20), nullable=True)  # beginner / intermediate / advanced

    # Content stats
    word_count = Column(Integer, default=0)
    reading_time = Column(Integer, default=0)  # estimated seconds
    language = Column(String(10), nullable=True)  # zh / en / mix

    # Video features
    has_code = Column(Boolean, default=False)
    has_math = Column(Boolean, default=False)
    is_tutorial = Column(Boolean, default=False)

    # User-editable
    user_tags = Column(JSON, nullable=True)  # ["tag1", "tag2"]
    notes = Column(Text, nullable=True)

    # Timestamps
    extracted_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class AsyncTask(Base):
    """通用异步任务表"""

    __tablename__ = "async_tasks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=True, index=True)
    task_id = Column(String(64), unique=True, index=True, nullable=False)
    task_type = Column(String(20), nullable=False)  # vec_page / asr / arc_meta_extract
    target = Column(
        JSON, nullable=False
    )  # {"bvid": "BV1xx", "cid": 123, "page_index": 0}
    status = Column(
        String(20), default="pending"
    )  # pending / processing / done / failed
    progress = Column(Integer, default=0)
    steps = Column(
        JSON, nullable=True
    )  # [{"name": "asr", "status": "done", "progress": 100}, ...]
    result = Column(JSON, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    completed_at = Column(DateTime, nullable=True)


class ChatSession(Base):
    """Chat session — uid-scoped metadata row.

    ``chat_session_id`` (UUID4) is the public identifier and the
    MongoDB lookup key for messages.  Messages themselves live in the
    ``chat_messages`` MongoDB collection; only session metadata stays
    in MySQL.
    """

    __tablename__ = "chat_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    chat_session_id = Column(String(64), unique=True, index=True, nullable=False)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=False, index=True)
    title = Column(String(200), nullable=True)
    status = Column(String(20), default="active")  # active / archived / deleted
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    last_message_at = Column(DateTime, nullable=True)

    created_at: datetime


# ==================== Pydantic 模型 (分P向量化) ====================

# ==================== Pydantic 模型 (聊天历史) ====================


# ==================== SQLAlchemy 模型 (用户 Embedding / ASR 配置) ====================


class UserEmbeddingConfig(Base):
    """用户 Embedding 配置表"""

    __tablename__ = "user_embedding_configs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=False, index=True)
    name = Column(String(64), nullable=False)
    provider = Column(String(32), nullable=False)
    api_key_encrypted = Column(Text, nullable=False)
    base_url = Column(Text, nullable=True)
    model = Column(Text, nullable=True)
    is_default = Column(Boolean, default=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    deleted_at = Column(DateTime, nullable=True)

    last_test_status = Column(String(20), nullable=True)
    last_test_error = Column(Text, nullable=True)
    last_test_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="embedding_configs")


class UserASRConfig(Base):
    """用户 ASR 配置表"""

    __tablename__ = "user_asr_configs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=False, index=True)
    name = Column(String(64), nullable=False)
    provider = Column(String(32), nullable=False)  # dashscope / openai / custom
    api_key_encrypted = Column(Text, nullable=False)
    base_url = Column(Text, nullable=True)
    model = Column(Text, nullable=True)  # paraformer-v2 / whisper-1 / ...
    is_default = Column(Boolean, default=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    deleted_at = Column(DateTime, nullable=True)

    last_test_status = Column(String(20), nullable=True)
    last_test_error = Column(Text, nullable=True)
    last_test_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="asr_configs")


# ==================== SQLAlchemy 模型 (多 Provider Credential) ====================


class UserCredential(Base):
    """用户多 Provider API Key 配置表"""

    __tablename__ = "user_credentials"

    id = Column(Integer, primary_key=True, autoincrement=True)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=False, index=True)
    name = Column(String(64), nullable=False)  # 用户自定义名称，如 "我的 OpenAI"
    provider = Column(
        String(32), nullable=False
    )  # openai / anthropic / deepseek / custom
    api_key_encrypted = Column(Text, nullable=False)
    base_url = Column(Text, nullable=True)
    default_model = Column(Text, nullable=True)
    is_default = Column(Boolean, default=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    deleted_at = Column(DateTime, nullable=True)

    last_test_status = Column(String(20), nullable=True)  # None | "ok" | "error"
    last_test_error = Column(Text, nullable=True)
    last_test_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="credentials")


class CredentialUsage(Base):
    """凭证用量记录表"""

    __tablename__ = "credential_usage"

    id = Column(Integer, primary_key=True, autoincrement=True)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=False, index=True)
    credential_id = Column(Integer, nullable=True)  # NULL = 系统默认 Key
    provider = Column(String(32), nullable=True)
    model = Column(String(64), nullable=True)
    prompt_tokens = Column(Integer, default=0)
    completion_tokens = Column(Integer, default=0)
    total_tokens = Column(Integer, default=0)
    api_calls = Column(Integer, default=1)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


# ==================== SQLAlchemy 模型 (Quiz 题目训练系统) ====================


class QuizSet(Base):
    """Quiz set metadata — uid-scoped.

    quiz_uuid is the MongoDB lookup key for quiz_questions.
    """

    __tablename__ = "quiz_sets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    quiz_uuid = Column(String(64), unique=True, index=True, nullable=False)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=True, index=True)
    title = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    question_count = Column(Integer, default=10)
    type_distribution = Column(
        JSON, nullable=True
    )  # {"single_choice": 3, "multi_choice": 2, ...}
    difficulty = Column(String(20), default="medium")  # easy / medium / hard
    folder_ids = Column(JSON, nullable=True)  # [1, 2, 3]
    source_type = Column(String(20), default="folder")  # "folder" / "pages"
    source_pages = Column(
        JSON, nullable=True
    )  # [{"bvid":"BVxxx","cid":123,"page_index":0,"page_title":"P1"}]
    bvid_count = Column(Integer, default=0)
    status = Column(String(20), default="generating")  # generating / done / failed
    error_message = Column(Text, nullable=True)
    total_score = Column(Integer, default=100)
    passing_score = Column(Integer, default=60)
    completed_at = Column(DateTime, nullable=True)
    # Quiz sharing — share_token is a separate unguessable secret so that
    # quiz_uuid (which is only a UUID4) cannot be enumerated. NULL = not shared.
    share_token = Column(String(32), unique=True, index=True, nullable=True)
    shared_at = Column(DateTime, nullable=True)
    # Optional expiry — NULL = never expires (until owner revokes).
    share_expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class QuizSubmission(Base):
    """Quiz submission record — uid-scoped."""

    __tablename__ = "quiz_submissions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    submission_uuid = Column(String(64), unique=True, index=True, nullable=False)
    quiz_uuid = Column(String(64), index=True, nullable=False)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=True, index=True)
    total_score = Column(Integer, nullable=True)
    auto_score = Column(Integer, nullable=True)
    manual_score = Column(Integer, nullable=True)
    passing_score = Column(Integer, nullable=True)
    is_complete = Column(Boolean, default=False)
    is_passed = Column(Boolean, nullable=True)
    correct_count = Column(Integer, default=0)
    total_question_count = Column(Integer, default=0)
    time_spent_seconds = Column(Integer, nullable=True)
    started_at = Column(DateTime, nullable=True)
    submitted_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    graded_at = Column(DateTime, nullable=True)


class QuizAnswer(Base):
    """答案明细"""

    __tablename__ = "quiz_answers"

    id = Column(Integer, primary_key=True, autoincrement=True)
    submission_uuid = Column(String(64), index=True, nullable=False)
    question_uuid = Column(String(64), index=True, nullable=False)
    question_type = Column(String(20), nullable=False)
    user_answer = Column(JSON, nullable=False)  # "A" or ["A", "C"] or "文本答案"
    user_answer_text = Column(Text, nullable=True)
    is_correct = Column(Boolean, nullable=True)
    auto_score = Column(Integer, nullable=True)
    manual_score = Column(Integer, nullable=True)
    final_score = Column(Integer, nullable=True)
    correct_answer_snapshot = Column(JSON, nullable=False)  # 批改时的正确答案快照
    matched_keywords = Column(JSON, nullable=True)
    keyword_match_rate = Column(Float, nullable=True)
    grading_detail = Column(JSON, nullable=True)
    submitted_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    graded_at = Column(DateTime, nullable=True)


# ==================== 用户中心 ORM (Plan 0020 Phase 1) ====================


class User(Base):
    """用户核心表 — 全局唯一 uid，软删除"""

    __tablename__ = "users"

    uid = Column(BigInteger, primary_key=True)
    status = Column(String(20), default="active")  # active / suspended / deleted

    # 身份标识 + 登录凭证
    email = Column(String(200), nullable=True, unique=True)
    phone = Column(String(20), nullable=True, unique=True)
    password_hash = Column(
        String(255), nullable=True
    )  # bcrypt, nullable = OAuth-only user
    email_verified = Column(Boolean, default=False)
    phone_verified = Column(Boolean, default=False)

    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    deleted_at = Column(DateTime, nullable=True)

    # relationships
    oauth_bindings = relationship("UserOAuth", back_populates="user", lazy="selectin")
    profile = relationship(
        "UserProfile", back_populates="user", uselist=False, lazy="selectin"
    )
    tokens = relationship("UserToken", back_populates="user", lazy="selectin")
    devices = relationship("UserDevice", back_populates="user", lazy="selectin")
    roles = relationship("RbacUserRole", back_populates="user", lazy="selectin")
    credentials = relationship("UserCredential", back_populates="user", lazy="selectin")
    embedding_configs = relationship(
        "UserEmbeddingConfig", back_populates="user", lazy="selectin"
    )
    asr_configs = relationship("UserASRConfig", back_populates="user", lazy="selectin")


class UserOAuth(Base):
    """第三方登录绑定表"""

    __tablename__ = "user_oauth"

    id = Column(Integer, primary_key=True, autoincrement=True)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=False)
    provider = Column(
        String(32), nullable=False
    )  # bilibili / wechat / qq / google / github
    provider_uid = Column(String(64), nullable=False)  # 平台用户ID（如 bili_mid）
    email = Column(String(200), nullable=True)  # OAuth 返回的邮箱（Google/微信等）
    union_id = Column(String(64), nullable=True)  # 微信 union_id
    access_token = Column(Text, nullable=True)  # AES-GCM encrypted
    refresh_token = Column(Text, nullable=True)  # AES-GCM encrypted
    expires_at = Column(DateTime, nullable=True)
    raw_data = Column(Text, nullable=True)  # JSON: 平台返回的原始用户信息
    is_primary = Column(Boolean, default=False)  # 是否主登录方式
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    deleted_at = Column(DateTime, nullable=True)  # 软删除（解绑）

    __table_args__ = (
        UniqueConstraint("provider", "provider_uid", name="uq_user_oauth_provider_uid"),
    )

    user = relationship("User", back_populates="oauth_bindings")


class UserProfile(Base):
    """用户资料表"""

    __tablename__ = "user_profile"

    uid = Column(BigInteger, ForeignKey("users.uid"), primary_key=True)
    nickname = Column(String(100), nullable=True)
    avatar = Column(String(500), nullable=True)
    bio = Column(Text, nullable=True)
    birthday = Column(Date, nullable=True)
    gender = Column(String(10), nullable=True)
    location = Column(String(100), nullable=True)
    timezone = Column(String(50), nullable=True)
    language = Column(String(20), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    deleted_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="profile")


class UserToken(Base):
    """Token 会话表（替代旧 user_sessions 的部分职责）"""

    __tablename__ = "user_tokens"

    session_token = Column(String(128), primary_key=True)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=False)
    device_id = Column(String(64), nullable=True)
    token_type = Column(String(20), default="access")  # access / refresh
    expires_at = Column(DateTime, nullable=True)
    ip = Column(String(64), nullable=True)
    user_agent = Column(Text, nullable=True)
    is_revoked = Column(Boolean, default=False)
    last_active_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    deleted_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="tokens")


class UserDevice(Base):
    """Device management — one row per known device fingerprint per user."""

    __tablename__ = "user_device"

    device_id = Column(String(64), primary_key=True)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=False)
    device_type = Column(String(20), nullable=True)  # desktop | mobile | tablet
    device_name = Column(String(100), nullable=True)  # "MacBook Pro" / "iPhone 15"
    os = Column(String(50), nullable=True)  # "Windows" / "macOS" / "iOS"
    os_version = Column(String(50), nullable=True)
    browser = Column(String(100), nullable=True)  # "Chrome" / "Safari"
    browser_version = Column(String(50), nullable=True)
    fingerprint = Column(String(128), nullable=True)
    trust_level = Column(String(20), default="unknown")  # unknown | trusted | flagged
    last_active_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    deleted_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="devices")

    __table_args__ = (
        UniqueConstraint("uid", "fingerprint"),
        Index("idx_user_device_uid", "uid"),
    )


class VerificationCode(Base):
    """验证码表 — 邮箱/手机号验证"""

    __tablename__ = "verification_codes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=False)
    target = Column(String(200), nullable=False)  # email or phone
    type = Column(String(20), nullable=False)  # email / sms
    purpose = Column(String(32), nullable=False)  # bind / change / reset_password
    code = Column(String(10), nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used = Column(Boolean, default=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        Index("idx_vc_target_purpose", "target", "purpose"),
        Index("idx_vc_uid", "uid"),
    )


class RbacRole(Base):
    """角色表"""

    __tablename__ = "rbac_role"

    role_id = Column(String(64), primary_key=True)
    name = Column(String(50), nullable=False)
    description = Column(Text, nullable=True)
    is_system = Column(Boolean, default=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class RbacUserRole(Base):
    """用户-角色关联表"""

    __tablename__ = "rbac_user_role"

    id = Column(Integer, primary_key=True, autoincrement=True)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=False)
    role_id = Column(String(64), ForeignKey("rbac_role.role_id"), nullable=False)
    granted_by = Column(BigInteger, nullable=True)
    granted_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    user = relationship("User", back_populates="roles")


# ==================== Cloud Drive models (Plan 0021) ====================


class CloudFolder(Base):
    """Cloud drive folder — uid-scoped hierarchical folder tree."""

    __tablename__ = "cloud_folders"

    id = Column(Integer, primary_key=True, autoincrement=True)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=False)
    parent_id = Column(Integer, ForeignKey("cloud_folders.id"), nullable=True)
    name = Column(String(200), nullable=False)
    video_count = Column(Integer, default=0)
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    deleted_at = Column(DateTime, nullable=True)


class CloudFile(Base):
    """Cloud drive file — uploaded media file metadata."""

    __tablename__ = "cloud_files"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_uuid = Column(String(64), unique=True, nullable=False, index=True)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=False)
    folder_id = Column(Integer, ForeignKey("cloud_folders.id"), nullable=True)
    original_name = Column(String(500), nullable=False)
    file_size = Column(BigInteger, nullable=False)
    mime_type = Column(String(128), nullable=False)
    duration = Column(Integer, nullable=True)
    bucket = Column(String(64), nullable=False)
    object_key = Column(String(500), nullable=False)
    etag = Column(String(64), nullable=True)
    upload_status = Column(String(20), default="uploading")
    asr_status = Column(String(20), default="pending")
    vector_status = Column(String(20), default="pending")
    vector_chunk_count = Column(Integer, default=0)
    title = Column(String(500), nullable=True)
    description = Column(Text, nullable=True)
    cover_url = Column(String(500), nullable=True)
    tags = Column(JSON, nullable=True)
    vectorizable = Column(Boolean, default=True, nullable=False)
    doc_parser = Column(String(20), nullable=True)
    doc_meta = Column(JSON, nullable=True)
    content_hash = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    deleted_at = Column(DateTime, nullable=True)

    __table_args__ = (UniqueConstraint("upload_uuid", name="uq_cloud_files_uuid"),)


class CloudUploadChunk(Base):
    """Cloud drive upload chunk — per-chunk tracking for resumable uploads."""

    __tablename__ = "cloud_upload_chunks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_uuid = Column(String(64), nullable=False)
    chunk_index = Column(Integer, nullable=False)
    chunk_size = Column(BigInteger, nullable=False)
    minio_upload_id = Column(String(128), nullable=True)
    upload_url = Column(Text, nullable=True)
    upload_status = Column(String(20), default="pending")
    etag = Column(String(64), nullable=True)
    retry_count = Column(Integer, default=0)
    last_heartbeat = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        UniqueConstraint("upload_uuid", "chunk_index", name="uq_cloud_chunks"),
    )


class CloudUploadSession(Base):
    """Cloud drive upload session — one session groups multiple file uploads."""

    __tablename__ = "cloud_upload_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_uuid = Column(String(64), unique=True, nullable=False)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=False)
    minio_upload_id = Column(String(128), nullable=True)
    total_files = Column(Integer, default=1)
    completed_files = Column(Integer, default=0)
    status = Column(String(20), default="active")
    last_heartbeat = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (UniqueConstraint("session_uuid", name="uq_upload_session"),)


class Workspace(Base):
    """Plan 0023: User workspace — a named retrieval scope binding cloud files/folders."""

    __tablename__ = "workspaces"

    id = Column(Integer, primary_key=True, autoincrement=True)
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=False)
    name = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    icon = Column(String(50), nullable=True)
    color = Column(String(20), nullable=True)
    file_count = Column(Integer, default=0)
    chunk_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    deleted_at = Column(DateTime, nullable=True)


class WorkspaceBinding(Base):
    """Plan 0023: Binding between workspace and cloud file/folder."""

    __tablename__ = "workspace_bindings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    workspace_id = Column(
        Integer, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    uid = Column(BigInteger, ForeignKey("users.uid"), nullable=False)
    bind_type = Column(String(10), nullable=False)
    folder_id = Column(Integer, ForeignKey("cloud_folders.id"), nullable=True)
    upload_uuid = Column(String(64), nullable=True)
    include_subfolders = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
