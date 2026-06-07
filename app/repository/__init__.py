# app/repository/__init__.py
"""Repository layer — database CRUD operations.

Each repository encapsulates all SQL for a single table or logical group.
Services depend on repositories, never on raw SQL/session directly.
"""

from app.repository.embedding_config_repository import (
    EmbeddingConfigRepository,
    get_embedding_config_repository,
)
from app.repository.asr_config_repository import (
    ASRConfigRepository,
    get_asr_config_repository,
)
from app.repository.credential_repository import (
    CredentialRepository,
    get_credential_repository,
)
from app.repository.usage_repository import (
    UsageRepository,
    get_usage_repository,
)
from app.repository.user_repository import (
    UserRepository,
    get_user_repository,
)
from app.repository.user_oauth_repository import (
    UserOAuthRepository,
    get_user_oauth_repository,
)
from app.repository.user_profile_repository import (
    UserProfileRepository,
    get_user_profile_repository,
)
from app.repository.user_token_repository import (
    UserTokenRepository,
    get_user_token_repository,
)
from app.repository.rbac_repository import (
    RbacRepository,
    get_rbac_repository,
)
from app.repository.favorite_repository import (
    FavoriteRepository,
    get_favorite_repository,
)
from app.repository.video_repository import (
    VideoRepository,
    get_video_repository,
)
from app.repository.video_metadata_repository import (
    VideoMetadataRepository,
    get_video_metadata_repository,
)
from app.repository.async_task_repository import (
    AsyncTaskRepository,
    get_async_task_repository,
)
from app.repository.vector_store_milvus import MilvusVectorStore
from app.repository.mongo_asr_repository import (
    save_asr, get_latest, get_version, list_versions, delete_all,
    count_documents, get_preview,
)

__all__ = [
    "EmbeddingConfigRepository",
    "get_embedding_config_repository",
    "ASRConfigRepository",
    "get_asr_config_repository",
    "CredentialRepository",
    "get_credential_repository",
    "UsageRepository",
    "get_usage_repository",
    "UserRepository",
    "get_user_repository",
    "UserOAuthRepository",
    "get_user_oauth_repository",
    "UserProfileRepository",
    "get_user_profile_repository",
    "UserTokenRepository",
    "get_user_token_repository",
    "RbacRepository",
    "get_rbac_repository",
    "FavoriteRepository",
    "get_favorite_repository",
    "VideoRepository",
    "get_video_repository",
    "VideoMetadataRepository",
    "get_video_metadata_repository",
    "AsyncTaskRepository",
    "get_async_task_repository",
    "MilvusVectorStore",
    "save_asr",
    "get_latest",
    "get_version",
    "list_versions",
    "delete_all",
    "count_documents",
    "get_preview",
]
