// Internal research-workspace file upload/download. app-ts submits experiment
// artifacts and generated manuscripts here; the cloud-drive owner (app-cloud)
// remains the only component holding MinIO credentials.
package router

import (
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"app-cloud/internal/middleware"
	"app-cloud/internal/model"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const maxInternalFileBytes = 256 * 1024 * 1024

func internalUploadFile(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		folderID, _ := strconv.ParseInt(strings.TrimSpace(c.Query("folder_id")), 10, 64)
		name := strings.TrimSpace(c.Query("name"))
		mimeType := strings.TrimSpace(c.Query("mime_type"))
		if name == "" {
			name = "artifact.bin"
		}
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
		if folderID > 0 {
			folder, err := d.Folders.GetByID(d.DB, folderID, uid)
			if err != nil || folder == nil {
				apiErr(c, http.StatusBadRequest, "目标文件夹不存在")
				return
			}
		}
		if d.Minio == nil {
			apiErr(c, http.StatusServiceUnavailable, "对象存储不可用")
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxInternalFileBytes+1)
		data, err := io.ReadAll(c.Request.Body)
		if err != nil || len(data) == 0 {
			apiErr(c, http.StatusBadRequest, "空文件或文件过大")
			return
		}
		if len(data) > maxInternalFileBytes {
			apiErr(c, http.StatusBadRequest, "文件超过 256MB 限制")
			return
		}
		uploadUUID := uuid.NewString()
		objectKey := fmt.Sprintf("%d/%s/file%s", uid, uploadUUID, extForMime(mimeType))
		if err := d.Minio.PutObject(c.Request.Context(), objectKey, data, mimeType); err != nil {
			apiErr(c, http.StatusServiceUnavailable, "对象存储写入失败")
			return
		}
		sum := sha256.Sum256(data)
		hash := fmt.Sprintf("%x", sum[:])
		row := &model.CloudFile{
			UploadUUID:   uploadUUID,
			UID:          uid,
			OriginalName: name,
			FileSize:     int64(len(data)),
			MimeType:     mimeType,
			Bucket:       d.Minio.Bucket(),
			ObjectKey:    objectKey,
			ContentHash:  &hash,
			UploadStatus: strPtr("completed"),
			Vectorizable: false,
		}
		if folderID > 0 {
			row.FolderID = &folderID
		}
		if err := d.Files.Create(d.DB, row); err != nil {
			apiErr(c, http.StatusInternalServerError, "文件元数据写入失败")
			return
		}
		c.JSON(http.StatusCreated, gin.H{
			"upload_uuid": uploadUUID,
			"id":          row.ID,
			"name":        name,
			"size":        len(data),
			"mime_type":   mimeType,
			"sha256":      hash,
			"folder_id":   folderID,
		})
	}
}

func internalDownloadFile(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		uploadUUID := strings.TrimSpace(c.Param("upload_uuid"))
		row, err := d.Files.GetByUUID(d.DB, uploadUUID, uid)
		if err != nil || row == nil {
			apiErr(c, http.StatusNotFound, "文件不存在")
			return
		}
		if d.Minio == nil {
			apiErr(c, http.StatusServiceUnavailable, "对象存储不可用")
			return
		}
		contentType, data, err := d.Minio.GetObjectWithType(c.Request.Context(), row.ObjectKey)
		if err != nil {
			apiErr(c, http.StatusServiceUnavailable, "对象存储读取失败")
			return
		}
		if contentType == "" {
			contentType = row.MimeType
		}
		c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", row.OriginalName))
		c.Data(http.StatusOK, contentType, data)
	}
}

func internalListFiles(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		var folderID *int64
		if raw := strings.TrimSpace(c.Query("folder_id")); raw != "" {
			id, err := strconv.ParseInt(raw, 10, 64)
			if err != nil {
				apiErr(c, http.StatusUnprocessableEntity, "folder_id 不合法")
				return
			}
			folderID = &id
		}
		rows, _, err := d.Files.ListByFolder(d.DB, uid, folderID, 1, 100, "created_at", "desc")
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "文件列表读取失败")
			return
		}
		items := make([]gin.H, 0, len(rows))
		for _, row := range rows {
			items = append(items, gin.H{
				"upload_uuid": row.UploadUUID,
				"name":        row.OriginalName,
				"size":        row.FileSize,
				"mime_type":   row.MimeType,
				"folder_id":   row.FolderID,
				"sha256":      row.ContentHash,
				"created_at":  row.CreatedAt,
			})
		}
		c.JSON(http.StatusOK, gin.H{"items": items})
	}
}

func internalDeleteFile(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		uploadUUID := strings.TrimSpace(c.Param("upload_uuid"))
		row, err := d.Files.GetByUUID(d.DB, uploadUUID, uid)
		if err != nil || row == nil {
			apiErr(c, http.StatusNotFound, "文件不存在")
			return
		}
		if err := d.Files.SoftDelete(d.DB, uploadUUID, uid); err != nil {
			apiErr(c, http.StatusInternalServerError, "文件删除失败")
			return
		}
		c.JSON(http.StatusOK, gin.H{"deleted": uploadUUID})
	}
}

func extForMime(mime string) string {
	mime = strings.ToLower(strings.TrimSpace(mime))
	exts := map[string]string{
		"application/json": ".json",
		"text/csv":         ".csv",
		"text/markdown":    ".md",
		"text/plain":       ".txt",
		"application/pdf":  ".pdf",
		"image/png":        ".png",
		"image/jpeg":       ".jpg",
		"application/zip":  ".zip",
	}
	if ext, ok := exts[mime]; ok {
		return ext
	}
	return ".bin"
}

func strPtr(v string) *string { return &v }
