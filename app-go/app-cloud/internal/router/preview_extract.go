package router

// 预览按需抽取：GET /cloud/video/:upload_uuid/preview 默认只读 Mongo 里流水线
// 落库的已解析文档（cloud_drive_documents）。从未跑过处理管线的文件（例如 AI
// 刚生成的 docx/markdown）没有那条记录，preview 会为空 —— 本文件负责兜底：
// 从 MinIO 读原始对象，用 internal/pipeline 的同一套解析器抽取纯文本。
//
// 契约：任何失败（对象缺失、超过大小上限、无 parser、加密/空 PDF、OOXML zip
// 超限、解析器报错）都只让 preview 为空并保持 200 —— 预览是只读增强，不能把
// 详情面板变成 5xx；调试信息走 debug 日志。
//
// cloud.go 只做调用（getDocumentPreview 的 fallback 分支）；分页语义与原
// Mongo 路径一致（nextOffset = offset + len(preview)，hasMore = next < total），
// 只是单位变为 rune（totalChars 按契约是字符数）。

import (
	"context"
	"errors"
	"log/slog"
	"path"
	"strings"
	"unicode/utf8"

	"app-cloud/internal/model"
	"app-cloud/internal/pipeline"
)

// previewExtractMaxBytes bounds the on-demand object read. The preview panel only
// needs the head of a document, and an unbounded read of a huge stored object
// would exhaust the API process's memory (the pipeline worker has its own cap).
const previewExtractMaxBytes = 50 << 20

// objectFetcher fetches one stored object. *minio.Client.GetObject satisfies it;
// tests inject an in-memory fake so no MinIO is needed.
type objectFetcher func(ctx context.Context, objectKey string) ([]byte, error)

// extractPreviewFromObject downloads the file's raw object (bounded both by the
// stored size and by the actual download length) and returns its plain text.
// ok=false means "nothing to preview"; every failure is debug-logged rather
// than returned, because the caller answers 200 with an empty preview.
func extractPreviewFromObject(ctx context.Context, f *model.CloudFile, fetch objectFetcher) (string, bool) {
	if f == nil || strings.TrimSpace(f.ObjectKey) == "" {
		return "", false
	}
	if f.FileSize > previewExtractMaxBytes {
		slog.Debug("[PREVIEW] on-demand extraction skipped: file too large",
			"upload_uuid", f.UploadUUID, "size", f.FileSize, "limit", previewExtractMaxBytes)
		return "", false
	}
	if fetch == nil {
		return "", false
	}
	data, err := fetch(ctx, f.ObjectKey)
	if err != nil {
		slog.Debug("[PREVIEW] on-demand extraction skipped: object read failed",
			"upload_uuid", f.UploadUUID, "err", err)
		return "", false
	}
	// Defense in depth: file_size is a DB value and may lag a concurrent write.
	if int64(len(data)) > previewExtractMaxBytes {
		slog.Debug("[PREVIEW] on-demand extraction skipped: object exceeds the read limit",
			"upload_uuid", f.UploadUUID, "bytes", len(data), "limit", previewExtractMaxBytes)
		return "", false
	}
	text, err := extractPreviewText(f.MimeType, f.OriginalName, data)
	if err != nil {
		slog.Debug("[PREVIEW] on-demand extraction skipped: parse failed",
			"upload_uuid", f.UploadUUID, "mime", f.MimeType, "name", f.OriginalName, "err", err)
		return "", false
	}
	if strings.TrimSpace(text) == "" {
		slog.Debug("[PREVIEW] on-demand extraction produced no text",
			"upload_uuid", f.UploadUUID, "mime", f.MimeType, "name", f.OriginalName)
		return "", false
	}
	return text, true
}

// extractPreviewText maps raw bytes to plain text:
//   - the pipeline parsers (pdf/docx/xlsx/pptx/markdown/html/text) when supported;
//   - ErrNoParser on a text-like file → the raw UTF-8 source (covers .tex/.log/
//     .csv and other human-readable types the vectorization parsers do not know);
//   - anything else → ("", err) so the caller can debug-log and render empty.
func extractPreviewText(mimeType, filename string, data []byte) (string, error) {
	parsed, err := pipeline.Extract(mimeType, filename, data)
	if err == nil {
		if parsed == nil {
			return "", nil
		}
		return parsed.Text, nil
	}
	if errors.Is(err, pipeline.ErrNoParser) && isTextLikeFile(mimeType, filename) {
		return utf8Text(data), nil
	}
	return "", err
}

// utf8Text keeps the object bytes as printable UTF-8 text: invalid sequences are
// replaced with U+FFFD (JSON-safe) and a leading BOM is dropped.
func utf8Text(data []byte) string {
	text := strings.ToValidUTF8(string(data), "\uFFFD")
	return strings.TrimPrefix(text, "\uFEFF")
}

// textPreviewExts are the file extensions the raw-text fallback accepts when no
// parser exists. Everything listed is human-readable text by construction, so a
// preview never renders binary garbage for a known document/script type.
var textPreviewExts = map[string]bool{
	// documents / data
	".tex": true, ".latex": true, ".log": true, ".csv": true, ".tsv": true,
	".json": true, ".jsonl": true, ".txt": true, ".text": true, ".yaml": true,
	".yml": true, ".toml": true, ".ini": true, ".cfg": true, ".conf": true,
	".sql": true, ".xml": true, ".md": true, ".markdown": true,
	// source code / scripts
	".py": true, ".js": true, ".mjs": true, ".cjs": true, ".ts": true,
	".tsx": true, ".jsx": true, ".go": true, ".rs": true, ".java": true,
	".kt": true, ".c": true, ".h": true, ".cc": true, ".cpp": true,
	".hpp": true, ".rb": true, ".php": true, ".sh": true, ".bash": true,
	".zsh": true, ".bat": true, ".cmd": true, ".ps1": true, ".r": true,
	".m": true, ".diff": true, ".patch": true, ".srt": true, ".vtt": true,
}

// isTextLikeFile reports whether an unparsable file can still be previewed as
// raw text: any text/* mime, a few textual application mimes, or a known
// human-readable extension (uploads frequently arrive as
// application/octet-stream, so the extension is the more reliable signal).
func isTextLikeFile(mimeType, filename string) bool {
	m := strings.ToLower(strings.TrimSpace(mimeType))
	if strings.HasPrefix(m, "text/") {
		return true
	}
	switch m {
	case "application/json", "application/xml", "application/x-yaml",
		"application/javascript", "application/x-sh", "application/x-tex",
		"application/x-latex", "application/sql", "application/toml":
		return true
	}
	ext := strings.ToLower(path.Ext(strings.TrimSpace(filename)))
	return textPreviewExts[ext]
}

// previewPage slices text into the paged preview response using rune offsets.
// totalChars is the rune count (contract); preview is [offset, offset+limit)
// clamped to the text; hasMore/nextOffset follow the existing preview semantics.
func previewPage(text string, offset, limit int) (preview string, total int, hasMore bool, next *int) {
	total = utf8.RuneCountInString(text)
	if offset < 0 {
		offset = 0
	}
	if offset > total {
		offset = total
	}
	end := offset + limit
	if limit <= 0 {
		end = offset
	} else if end > total || end < offset {
		end = total
	}
	preview = text[byteIndexRune(text, offset):byteIndexRune(text, end)]
	nextOffset := offset + utf8.RuneCountInString(preview)
	if nextOffset < total {
		next = &nextOffset
		return preview, total, true, next
	}
	return preview, total, false, nil
}

// byteIndexRune returns the byte index where the n-th rune starts (len(text)
// when n >= rune count). Range-over-string decodes runes exactly like
// []rune(text) for counting purposes, without allocating the rune slice.
func byteIndexRune(text string, n int) int {
	if n <= 0 {
		return 0
	}
	index := 0
	for bytePos := range text {
		if index == n {
			return bytePos
		}
		index++
	}
	return len(text)
}
