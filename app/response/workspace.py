"""Plan 0023: Workspace request/response schemas."""

from __future__ import annotations

from typing import Literal, Optional
from pydantic import BaseModel, Field


class WorkspaceCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    icon: Optional[str] = Field(None, max_length=50)
    color: Optional[str] = Field(None, max_length=20)


class WorkspaceUpdateRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    icon: Optional[str] = Field(None, max_length=50)
    color: Optional[str] = Field(None, max_length=20)


class BindingCreateRequest(BaseModel):
    bindType: Literal["folder", "file"] = Field(...)
    folderId: Optional[int] = None
    uploadUuid: Optional[str] = None
    includeSubfolders: bool = True


class BindingResponse(BaseModel):
    id: int
    bindType: str
    folderId: Optional[int] = None
    folderName: Optional[str] = None
    uploadUuid: Optional[str] = None
    fileName: Optional[str] = None
    includeSubfolders: bool


class WorkspaceResponse(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    fileCount: int = 0
    chunkCount: int = 0
    bindings: list[BindingResponse] = []
    createdAt: str = ""
    updatedAt: str = ""


class WorkspaceFileItem(BaseModel):
    uploadUuid: str
    originalName: str
    mimeType: str
    vectorizable: bool = True
    vectorStatus: str = "pending"
    vectorChunkCount: int = 0
