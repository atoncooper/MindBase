package tests

// Wire-shape guards for the DTO layer: every domain's JSON must keep the exact
// field names, null vs [] semantics and optional-key behavior the frontend and
// the agent tools rely on.

import (
	"encoding/json"
	"net/http"
	"sort"
	"testing"
	"time"

	"app-cloud/internal/config"
	"app-cloud/internal/dto"
	"app-cloud/internal/model"
	"app-cloud/internal/router"
)

// asJSON marshals v and decodes it back into a generic object for inspection.
func asJSON(t *testing.T, v any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out
}

// assertKeys compares the object's exact key set (no extra or missing keys).
func assertKeys(t *testing.T, obj map[string]any, want ...string) {
	t.Helper()
	got := make([]string, 0, len(obj))
	for k := range obj {
		got = append(got, k)
	}
	sort.Strings(got)
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("key set = %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("key set = %v, want %v", got, want)
		}
	}
}

func TestUploadWireShape(t *testing.T) {
	init := dto.UploadInitResponse{
		UploadUUID: "u", SessionUUID: "s", MinioUploadID: "m",
		ChunkCount: 2, ChunkSize: 10,
		PresignedURLs: []dto.UploadPresignedItem{{ChunkIndex: 0, ChunkSize: 10, URL: "http://x"}},
	}
	obj := asJSON(t, init)
	assertKeys(t, obj, "uploadUuid", "sessionUuid", "minioUploadId", "chunkCount", "chunkSize", "presignedUrls")
	item := asJSON(t, init.PresignedURLs[0])
	assertKeys(t, item, "chunkIndex", "chunkSize", "url")

	complete := asJSON(t, dto.UploadCompleteResponse{UploadUUID: "u", ETag: "e", Status: "completed"})
	assertKeys(t, complete, "uploadUuid", "etag", "status")

	resume := asJSON(t, dto.UploadResumeResponse{
		UploadUUID: "u", MinioUploadID: "m",
		PendingChunks: []dto.UploadResumeChunk{},
	})
	assertKeys(t, resume, "uploadUuid", "minioUploadId", "pendingChunks")
	if _, ok := resume["pendingChunks"].([]any); !ok {
		t.Fatalf("pendingChunks must be an array: %v", resume["pendingChunks"])
	}

	assertKeys(t, asJSON(t, dto.UploadHeartbeatResponse{Ack: true}), "ack")
}

func TestFolderWireShape(t *testing.T) {
	item := dto.FolderItem{ID: 1, Name: "root", VideoCount: 0, Children: []dto.FolderItem{}}
	obj := asJSON(t, item)
	assertKeys(t, obj, "id", "parent_id", "name", "video_count", "children")
	if obj["parent_id"] != nil {
		t.Fatalf("parent_id must be null at root: %v", obj["parent_id"])
	}
	children, ok := obj["children"].([]any)
	if !ok || len(children) != 0 {
		t.Fatalf("children must be [] for a leaf: %v", obj["children"])
	}

	tree := asJSON(t, dto.FolderTreeResponse{Folders: []dto.FolderItem{item}})
	assertKeys(t, tree, "folders")

	created := asJSON(t, dto.FolderResponse{ID: 2, Name: "a", VideoCount: 0})
	assertKeys(t, created, "id", "parent_id", "name", "video_count")

	deleted := asJSON(t, dto.FolderDeleteResponse{Deleted: true, AffectedFiles: 3})
	assertKeys(t, deleted, "deleted", "affectedFiles")
}

func TestFileWireShape(t *testing.T) {
	item := dto.VideoItem{UploadUUID: "u", OriginalName: "a.pdf", AsrStatus: "pending", VectorStatus: "pending"}
	list := asJSON(t, dto.VideoListResponse{Videos: []dto.VideoItem{item}, Page: 1, PageSize: 50})
	assertKeys(t, list, "videos", "total", "page", "pageSize", "hasMore")
	itemJSON := asJSON(t, item)
	assertKeys(t, itemJSON, "upload_uuid", "original_name", "file_size", "mime_type",
		"duration", "asr_status", "vector_status", "title", "cover_url", "createdAt")
	if itemJSON["title"] != nil || itemJSON["cover_url"] != nil || itemJSON["duration"] != nil {
		t.Fatalf("nullable file fields must serialize as null: %v", itemJSON)
	}

	detail := asJSON(t, dto.VideoDetailResponse{UploadUUID: "u", FolderName: "", VectorChunkCount: 0})
	assertKeys(t, detail, "upload_uuid", "original_name", "file_size", "mime_type", "duration",
		"asr_status", "vector_status", "title", "cover_url", "created_at", "description", "tags",
		"folder_id", "folderName", "asrPreview", "vector_chunk_count")
	if detail["tags"] != nil {
		t.Fatalf("nil tags must serialize as null: %v", detail["tags"])
	}
	if detail["asrPreview"] != nil {
		t.Fatalf("asrPreview must be null when absent: %v", detail["asrPreview"])
	}

	preview := asJSON(t, dto.DocumentPreviewResponse{UploadUUID: "u", HasMore: false})
	assertKeys(t, preview, "upload_uuid", "fileName", "mime_type", "vectorizable", "preview",
		"docMeta", "offset", "limit", "totalChars", "hasMore", "nextOffset")
	if preview["nextOffset"] != nil {
		t.Fatalf("nextOffset must be null on the last page: %v", preview["nextOffset"])
	}

	raw := asJSON(t, dto.RawFileResponse{URL: "http://x", ViewMode: "pdf"})
	assertKeys(t, raw, "url", "content", "mimeType", "fileName", "fileSize", "viewMode")
	if raw["content"] != nil {
		t.Fatalf("content must be null when not inlined: %v", raw["content"])
	}

	status := asJSON(t, dto.VideoStatusResponse{})
	assertKeys(t, status, "asr_status", "asrProgress", "vector_status", "vectorChunkCount")

	search := asJSON(t, dto.SearchFilesResponse{Results: []dto.VideoItem{}, Total: 0})
	assertKeys(t, search, "results", "total")

	assertKeys(t, asJSON(t, dto.VideoDeleteResponse{Deleted: true, UploadUUID: "u"}), "deleted", "uploadUuid")
	assertKeys(t, asJSON(t, dto.VideoProcessResponse{UploadUUID: "u"}), "uploadUuid")
	assertKeys(t, asJSON(t, dto.VideoReprocessResponse{UploadUUID: "u", TaskID: "t"}), "uploadUuid", "taskId")
}

func TestTrashWireShape(t *testing.T) {
	item := asJSON(t, dto.TrashItem{UploadUUID: "u", OriginalName: "a"})
	assertKeys(t, item, "upload_uuid", "original_name", "file_size", "mime_type", "deleted_at", "purge_at")
	if item["deleted_at"] != nil || item["purge_at"] != nil {
		t.Fatalf("timestamps must serialize as null: %v", item)
	}

	list := asJSON(t, dto.TrashListResponse{Items: []dto.TrashItem{}, Total: 0})
	assertKeys(t, list, "items", "total")
	assertKeys(t, asJSON(t, dto.TrashRestoreResponse{Restored: true, UploadUUID: "u"}), "restored", "upload_uuid")
	assertKeys(t, asJSON(t, dto.TrashPurgeResponse{Purged: true, UploadUUID: "u"}), "purged", "upload_uuid")
	assertKeys(t, asJSON(t, dto.EmptyTrashResponse{Purged: 2}), "purged")
}

func TestQuotaWireShape(t *testing.T) {
	ok := asJSON(t, dto.QuotaResponse{Used: 1, Quota: 2, Tier: "free", Pending: 0})
	assertKeys(t, ok, "used", "quota", "tier", "pending")
	failed := asJSON(t, dto.QuotaResponse{Used: 1, Quota: 2, Tier: "free", Pending: 0, Error: "boom"})
	assertKeys(t, failed, "used", "quota", "tier", "pending", "error")
}

func TestShareWireShape(t *testing.T) {
	token, url := "tok", "/cloud/s/tok"
	now := time.Now()
	view := asJSON(t, dto.ShareView{
		ID: 1, FileID: 2, ExtractionCode: "", CreatedAt: &now,
		TargetType: "file", ModerationStatus: model.ModerationActive,
		ShareToken: &token, ShareURL: &url,
	})
	assertKeys(t, view, "id", "file_id", "has_code", "extraction_code", "expires_at",
		"max_downloads", "view_count", "download_count", "is_revoked", "created_at",
		"target_type", "folder_id", "legal_ack", "content_review_ack",
		"content_review_policy_version", "content_review_ack_at", "moderation_status",
		"moderation_reason", "moderation_time", "moderation_by", "share_token", "share_url")
	if view["expires_at"] != nil || view["max_downloads"] != nil {
		t.Fatalf("nullable share fields must serialize as null: %v", view)
	}

	list := asJSON(t, dto.ShareListResponse{Shares: []dto.ShareView{}, Total: 0})
	assertKeys(t, list, "shares", "total")
	assertKeys(t, asJSON(t, dto.ShareRevokeResponse{Revoked: true}), "revoked")
	assertKeys(t, asJSON(t, dto.ShareCodeResponse{Updated: true}), "updated")

	fileInfo := dto.ShareInfoResponse{TargetType: "file", RequiresCode: false, Challenge: "c"}
	name, size, mime := "a.pdf", int64(10), "application/pdf"
	fileInfo.FileName, fileInfo.FileSize, fileInfo.MimeType = &name, &size, &mime
	fileObj := asJSON(t, fileInfo)
	assertKeys(t, fileObj, "targetType", "requiresCode", "createdAt", "expiresAt", "challenge",
		"fileName", "fileSize", "mimeType")
	if fileObj["createdAt"] != nil || fileObj["expiresAt"] != nil {
		t.Fatalf("nullable timestamps must be null: %v", fileObj)
	}

	folderName := "folder"
	truncated := false
	files := []dto.SharePublicFile{}
	folderInfo := asJSON(t, dto.ShareInfoResponse{
		TargetType: "folder", RequiresCode: true, Challenge: "c",
		FolderName: &folderName, Files: &files, Truncated: &truncated,
	})
	assertKeys(t, folderInfo, "targetType", "requiresCode", "createdAt", "expiresAt",
		"challenge", "folderName", "files", "truncated")
	if f, ok := folderInfo["files"].([]any); !ok || len(f) != 0 {
		t.Fatalf("files must be [] for an empty folder share: %v", folderInfo["files"])
	}
	if folderInfo["truncated"] != false {
		t.Fatalf("truncated must stay present and false: %v", folderInfo["truncated"])
	}
	pubFile := asJSON(t, dto.SharePublicFile{FileID: 1, Name: "a", Path: "x"})
	assertKeys(t, pubFile, "fileId", "name", "size", "mimeType", "path")

	assertKeys(t, asJSON(t, dto.ShareAttestResponse{Ticket: "t", ExpiresIn: 60}), "ticket", "expiresIn")
	assertKeys(t, asJSON(t, dto.ShareAccessResponse{URL: "u"}), "url", "viewMode", "mimeType",
		"fileName", "fileSize", "expiresIn")
}

func TestAdminReviewWireShape(t *testing.T) {
	grant := asJSON(t, dto.AdminReviewAccessResponse{URL: "http://x", ViewMode: "pdf", ExpiresIn: 900})
	assertKeys(t, grant, "url", "viewMode", "mimeType", "fileName", "fileSize", "expiresIn")

	truncated := false
	textObj := asJSON(t, dto.AdminReviewAccessResponse{
		ViewMode: "text", Text: "body", Truncated: &truncated,
	})
	assertKeys(t, textObj, "viewMode", "mimeType", "fileName", "fileSize", "expiresIn", "text", "truncated")
	if textObj["truncated"] != false {
		t.Fatalf("text preview must expose truncated=false: %v", textObj["truncated"])
	}
}

func TestRefWireShape(t *testing.T) {
	omitted := asJSON(t, dto.SaveRefResponse{Saved: 1})
	assertKeys(t, omitted, "saved")
	root := int64(9)
	withRoot := asJSON(t, dto.SaveRefResponse{Saved: 2, RootFolderID: &root})
	assertKeys(t, withRoot, "saved", "rootFolderId")

	item := asJSON(t, dto.RefItem{ID: 1, Name: "a", Status: "alive", IsRef: true})
	assertKeys(t, item, "id", "name", "size", "mimeType", "folderId", "status", "shareId",
		"sourceUploadUuid", "sourceName", "createdAt", "isRef")
	list := asJSON(t, dto.RefListResponse{Refs: []dto.RefItem{}, Total: 0})
	assertKeys(t, list, "refs", "total")
	assertKeys(t, asJSON(t, dto.RefDeleteResponse{Deleted: true}), "deleted")
	assertKeys(t, asJSON(t, dto.RefRawResponse{URL: "u"}), "url", "viewMode", "mimeType",
		"fileName", "fileSize", "expiresIn")
}

func TestWorkspaceWireShape(t *testing.T) {
	ws := asJSON(t, dto.Workspace{ID: 1, Name: "w", Bindings: []dto.WorkspaceBinding{}})
	assertKeys(t, ws, "id", "name", "description", "icon", "color", "fileCount", "chunkCount",
		"bindings", "createdAt", "updatedAt")
	if b, ok := ws["bindings"].([]any); !ok || len(b) != 0 {
		t.Fatalf("bindings must be [] when empty: %v", ws["bindings"])
	}
	binding := asJSON(t, dto.WorkspaceBinding{ID: 1, BindType: "folder", IncludeSubfolders: true})
	assertKeys(t, binding, "id", "bindType", "folderId", "folderName", "uploadUuid", "fileName", "includeSubfolders")
	if binding["folderName"] != nil || binding["fileName"] != nil {
		t.Fatalf("binding names must serialize as null: %v", binding)
	}
	fileItem := asJSON(t, dto.WorkspaceFileItem{UploadUUID: "u", Vectorizable: true})
	assertKeys(t, fileItem, "uploadUuid", "originalName", "mimeType", "vectorizable",
		"vectorStatus", "vectorChunkCount")
	assertKeys(t, asJSON(t, dto.WorkspaceDeleteResponse{Deleted: true}), "deleted")
}

func TestInternalAndCommonWireShape(t *testing.T) {
	reconcile := asJSON(t, dto.ReconcileResponse{UID: 1, OrphanSample: []string{}})
	assertKeys(t, reconcile, "uid", "db_active_bytes", "db_active_count", "db_trash_bytes",
		"minio_bytes", "minio_count", "orphan_objects", "orphan_sample", "missing_objects", "drift_bytes")

	health := asJSON(t, dto.HealthResponse{Status: "ok", Service: "app-cloud"})
	assertKeys(t, health, "status", "service")
	assertKeys(t, asJSON(t, dto.ErrorResponse{Detail: "boom"}), "detail")
}

// TestHealthEndpointWire exercises the health route through the real engine.
func TestHealthEndpointWire(t *testing.T) {
	engine := router.New(router.Deps{Cfg: &config.Config{}})
	code, body := doJSON(t, engine, http.MethodGet, "/health", "", nil)
	if code != http.StatusOK {
		t.Fatalf("health status = %d", code)
	}
	assertKeys(t, body, "status", "service")
	if body["status"] != "ok" || body["service"] != "app-cloud" {
		t.Fatalf("health body = %v", body)
	}
}
