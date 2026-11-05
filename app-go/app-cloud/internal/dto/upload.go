package dto

// Upload endpoints keep the legacy camelCase wire contract clients already
// rely on (init params, presigned URLs, part identifiers).

// UploadInitRequest is the POST /cloud/upload/init body.
type UploadInitRequest struct {
	Filename string `json:"filename" binding:"required"`
	FileSize int64  `json:"fileSize" binding:"required"`
	MimeType string `json:"mimeType" binding:"required"`
	FolderID *int64 `json:"folderId"`
}

// UploadHeartbeatRequest is the POST /cloud/upload/heartbeat body.
type UploadHeartbeatRequest struct {
	SessionUUID string `json:"sessionUuid" binding:"required"`
}

// UploadHeartbeatResponse acknowledges a live upload session.
type UploadHeartbeatResponse struct {
	Ack bool `json:"ack"`
}

// UploadPart is one completed multipart part (S3 field names, uppercase).
type UploadPart struct {
	PartNumber int    `json:"PartNumber"`
	ETag       string `json:"ETag"`
}

// UploadCompleteRequest is the POST /cloud/upload/{uuid}/complete body.
type UploadCompleteRequest struct {
	Parts []UploadPart `json:"parts" binding:"required"`
}

// UploadPresignedItem is one chunk's presigned PUT target.
type UploadPresignedItem struct {
	ChunkIndex int64  `json:"chunkIndex"`
	ChunkSize  int64  `json:"chunkSize"`
	URL        string `json:"url"`
}

// UploadInitResponse tells the client how to upload the object in chunks.
type UploadInitResponse struct {
	UploadUUID    string                `json:"uploadUuid"`
	SessionUUID   string                `json:"sessionUuid"`
	MinioUploadID string                `json:"minioUploadId"`
	ChunkCount    int64                 `json:"chunkCount"`
	ChunkSize     int64                 `json:"chunkSize"`
	PresignedURLs []UploadPresignedItem `json:"presignedUrls"`
}

// UploadCompleteResponse acknowledges a finalized multipart upload.
type UploadCompleteResponse struct {
	UploadUUID string `json:"uploadUuid"`
	ETag       string `json:"etag"`
	Status     string `json:"status"`
}

// UploadResumeChunk is one chunk still to be (re)uploaded.
type UploadResumeChunk struct {
	ChunkIndex int64  `json:"chunkIndex"`
	ChunkSize  int64  `json:"chunkSize"`
	URL        string `json:"url"`
}

// UploadResumeResponse re-issues presigned URLs for an interrupted upload.
type UploadResumeResponse struct {
	UploadUUID    string              `json:"uploadUuid"`
	MinioUploadID string              `json:"minioUploadId"`
	PendingChunks []UploadResumeChunk `json:"pendingChunks"`
}
