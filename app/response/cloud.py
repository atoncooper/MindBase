"""
Pydantic v2 models for cloud drive API request/response types.
"""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


# ── Upload Init ────────────────────────────────────────────────────

class UploadInitRequest(BaseModel):
    filename: str
    fileSize: int
    mimeType: str
    folderId: Optional[int] = None


class PresignedUrlItem(BaseModel):
    chunkIndex: int
    chunkSize: int
    url: str


class UploadInitResponse(BaseModel):
    uploadUuid: str
    sessionUuid: str
    minioUploadId: str
    chunkCount: int
    chunkSize: int
    presignedUrls: list[PresignedUrlItem]


# ── Upload Complete ───────────────────────────────────────────────

class UploadPart(BaseModel):
    PartNumber: int
    ETag: str


class UploadCompleteRequest(BaseModel):
    parts: list[UploadPart]


class UploadCompleteResponse(BaseModel):
    uploadUuid: str
    etag: str
    status: str


# ── Heartbeat ──────────────────────────────────────────────────────

class HeartbeatRequest(BaseModel):
    sessionUuid: str


class HeartbeatResponse(BaseModel):
    ack: bool = True


# ── Resume ─────────────────────────────────────────────────────────

class ResumeChunk(BaseModel):
    chunkIndex: int
    chunkSize: int
    url: str


class ResumeResponse(BaseModel):
    uploadUuid: str
    minioUploadId: str
    pendingChunks: list[ResumeChunk]


# ── Folders ─────────────────────────────────────────────────────────

class FolderTreeItem(BaseModel):
    model_config = {"populate_by_name": True, "by_alias": False}

    id: int
    parentId: Optional[int] = Field(default=None, alias="parent_id")
    name: str
    videoCount: int = Field(default=0, alias="video_count")
    children: list["FolderTreeItem"] = Field(default_factory=list)


class FolderTreeResponse(BaseModel):
    folders: list[FolderTreeItem]


class FolderCreateRequest(BaseModel):
    parentId: Optional[int] = None
    name: str


class FolderResponse(BaseModel):
    model_config = {"from_attributes": True, "populate_by_name": True, "by_alias": False}

    id: int
    parentId: Optional[int] = Field(default=None, alias="parent_id")
    name: str
    videoCount: int = Field(default=0, alias="video_count")


class FolderUpdateRequest(BaseModel):
    name: Optional[str] = None
    parentId: Optional[int] = None


class FolderDeleteResponse(BaseModel):
    deleted: bool
    affectedFiles: int = 0


# ── Videos (list) ───────────────────────────────────────────────────

class VideoItem(BaseModel):
    model_config = {"from_attributes": True, "populate_by_name": True, "by_alias": False}

    uploadUuid: str = Field(alias="upload_uuid")
    originalName: str = Field(alias="original_name")
    fileSize: int = Field(alias="file_size")
    mimeType: str = Field(alias="mime_type")
    duration: Optional[int] = None
    asrStatus: str = Field(alias="asr_status")
    vectorStatus: str = Field(alias="vector_status")
    title: Optional[str] = None
    coverUrl: Optional[str] = Field(default=None, alias="cover_url")
    createdAt: datetime = Field(alias="created_at")


class VideoListResponse(BaseModel):
    videos: list[VideoItem]
    total: int
    page: int
    pageSize: int
    hasMore: bool


# ── Video detail ────────────────────────────────────────────────────

class VideoDetailResponse(BaseModel):
    model_config = {"from_attributes": True, "populate_by_name": True, "by_alias": False}

    uploadUuid: str = Field(alias="upload_uuid")
    originalName: str = Field(alias="original_name")
    fileSize: int = Field(alias="file_size")
    mimeType: str = Field(alias="mime_type")
    duration: Optional[int] = None
    asrStatus: str = Field(alias="asr_status")
    vectorStatus: str = Field(alias="vector_status")
    title: Optional[str] = None
    coverUrl: Optional[str] = Field(default=None, alias="cover_url")
    createdAt: datetime = Field(alias="created_at")
    description: Optional[str] = None
    tags: Optional[list[str]] = None
    folderId: Optional[int] = Field(default=None, alias="folder_id")
    folderName: Optional[str] = ""
    asrPreview: Optional[str] = None
    vectorChunkCount: int = Field(default=0, alias="vector_chunk_count")


# ── Video update ────────────────────────────────────────────────────

class VideoUpdateRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[list[str]] = None
    folderId: Optional[int] = None


# ── Processing ──────────────────────────────────────────────────────

class VideoProcessResponse(BaseModel):
    uploadUuid: str
    asrTaskId: Optional[str] = None
    vectorTaskId: Optional[str] = None


class VideoStatusResponse(BaseModel):
    model_config = {"from_attributes": True, "populate_by_name": True, "by_alias": False}

    asrStatus: str = Field(alias="asr_status")
    asrProgress: int = 0
    vectorStatus: str = Field(alias="vector_status")
    vectorChunkCount: int = Field(default=0, alias="vector_chunk_count")


# ── Post-init self-referencing model rebuild ───────────────────────

FolderTreeItem.model_rebuild()
