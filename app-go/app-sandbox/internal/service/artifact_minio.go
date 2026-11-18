package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/runtime"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// MinioArtifactStore collects declared output files through execd's file API,
// uploads the bytes to MinIO and hands out presigned download URLs.
//
// Collection is best effort: a missing glob/directory or one unreadable file
// never fails the execution; the caller still gets the files that succeeded.
type MinioArtifactStore struct {
	rt       runtime.Runtime
	sdk      *minio.Client
	bucket   string
	endpoint string
	public   string
	region   string
	maxFile  int64
}

const (
	maxArtifactFiles = 64
	artifactFindTime = 30 * time.Second
)

// NewMinioArtifactStore wires the MinIO client and ensures the bucket exists.
func NewMinioArtifactStore(cfg *config.Config, rt runtime.Runtime) (*MinioArtifactStore, error) {
	raw := strings.TrimSpace(cfg.Minio.Endpoint)
	if raw == "" {
		return nil, fmt.Errorf("minio endpoint is empty")
	}
	host := raw
	secure := cfg.Minio.Secure
	if u, err := url.Parse(raw); err == nil && u.Host != "" {
		host = u.Host
		if u.Scheme == "https" {
			secure = true
		}
	}
	host = strings.TrimRight(host, "/")
	sdk, err := minio.New(host, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.Minio.AccessKey, cfg.Minio.SecretKey, ""),
		Secure: secure,
		Region: strings.TrimSpace(cfg.Minio.Region),
	})
	if err != nil {
		return nil, fmt.Errorf("minio client: %w", err)
	}
	store := &MinioArtifactStore{
		rt:       rt,
		sdk:      sdk,
		bucket:   strings.TrimSpace(cfg.Minio.Bucket),
		endpoint: strings.TrimRight(raw, "/"),
		public:   strings.TrimRight(strings.TrimSpace(cfg.Minio.PublicEndpoint), "/"),
		region:   strings.TrimSpace(cfg.Minio.Region),
		maxFile:  cfg.Artifacts.MaxFileBytes,
	}
	if store.maxFile <= 0 {
		store.maxFile = 20 << 20
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	exists, err := sdk.BucketExists(ctx, store.bucket)
	if err != nil {
		return nil, fmt.Errorf("minio bucket check: %w", err)
	}
	if !exists {
		if err := sdk.MakeBucket(ctx, store.bucket, minio.MakeBucketOptions{Region: store.region}); err != nil {
			return nil, fmt.Errorf("minio bucket create: %w", err)
		}
		slog.Info("[ARTIFACTS] minio bucket created", "bucket", store.bucket)
	}
	slog.Info("[ARTIFACTS] minio store ready", "endpoint", host, "bucket", store.bucket, "secure", secure)
	return store, nil
}

// Collect implements ArtifactStore.
func (m *MinioArtifactStore) Collect(ctx context.Context, sandboxID string, globs []string) ([]ArtifactCandidate, error) {
	globs = normalizeGlobs(globs)
	if len(globs) == 0 {
		return nil, nil
	}
	files, err := m.listFiles(ctx, sandboxID, globs)
	if err != nil {
		return nil, err
	}
	out := make([]ArtifactCandidate, 0, len(files))
	for _, file := range files {
		if len(out) >= maxArtifactFiles {
			break
		}
		if file.Size <= 0 || file.Size > m.maxFileBytes() {
			continue
		}
		data, derr := m.rt.DownloadFile(ctx, sandboxID, file.Path, m.maxFileBytes())
		if derr != nil {
			slog.Warn("[ARTIFACTS] download failed", "sandbox", sandboxID, "path", file.Path, "err", derr)
			continue
		}
		sum := sha256.Sum256(data)
		sha := hex.EncodeToString(sum[:])
		name := path.Base(file.Path)
		key := "sandbox/" + sandboxID + "/" + sha[:16] + "-" + sanitizeName(name)
		contentType := mime.TypeByExtension(path.Ext(name))
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		if _, perr := m.sdk.PutObject(ctx, m.bucket, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{ContentType: contentType}); perr != nil {
			slog.Warn("[ARTIFACTS] upload failed", "key", key, "err", perr)
			continue
		}
		out = append(out, ArtifactCandidate{
			Name:        name,
			SizeBytes:   int64(len(data)),
			SHA256:      sha,
			ContentType: contentType,
			ObjectKey:   key,
		})
	}
	return out, nil
}

// Presign implements ArtifactStore.
// Read implements ArtifactStore by fetching the object bytes from MinIO.
func (m *MinioArtifactStore) Read(ctx context.Context, objectKey string, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		maxBytes = 32 << 20
	}
	object, err := m.sdk.GetObject(ctx, m.bucket, objectKey, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer object.Close()
	data, err := io.ReadAll(io.LimitReader(object, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("artifact exceeds %d bytes", maxBytes)
	}
	return data, nil
}

func (m *MinioArtifactStore) Presign(ctx context.Context, objectKey string, ttl time.Duration) (string, error) {
	u, err := m.sdk.Presign(ctx, "GET", m.bucket, objectKey, ttl, url.Values{})
	if err != nil {
		return "", err
	}
	internal := u.String()
	if !strings.HasPrefix(internal, m.endpoint) {
		return internal, nil
	}
	base := m.public
	if base == "" {
		base = "/minio-proxy"
	}
	return base + internal[len(m.endpoint):], nil
}

type artifactFile struct {
	Path string
	Size int64
}

func (m *MinioArtifactStore) listFiles(ctx context.Context, sandboxID string, globs []string) ([]artifactFile, error) {
	roots := make([]string, 0, len(globs))
	seen := map[string]bool{}
	for _, glob := range globs {
		root := globRoot(glob)
		if root == "" || seen[root] {
			continue
		}
		seen[root] = true
		roots = append(roots, root)
	}
	if len(roots) == 0 {
		return nil, nil
	}
	var quoted []string
	for _, root := range roots {
		quoted = append(quoted, shellQuotePath(root))
	}
	command := "find " + strings.Join(quoted, " ") + " -type f -exec stat -c '%s %n' {} + 2>/dev/null || true"
	result, err := m.rt.Exec(ctx, runtime.ExecRequest{
		SandboxID: sandboxID,
		Language:  "bash",
		Code:      command,
		Timeout:   artifactFindTime,
	})
	if err != nil {
		return nil, fmt.Errorf("artifact find: %w", err)
	}
	files := make([]artifactFile, 0, 16)
	seenPaths := map[string]bool{}
	for _, line := range strings.Split(result.Stdout, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		sizeText, filePath, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		filePath = strings.TrimSpace(filePath)
		size, perr := strconv.ParseInt(strings.TrimSpace(sizeText), 10, 64)
		if perr != nil || filePath == "" || seenPaths[filePath] {
			continue
		}
		if !matchesAnyGlob(filePath, globs) {
			continue
		}
		seenPaths[filePath] = true
		files = append(files, artifactFile{Path: filePath, Size: size})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}

func (m *MinioArtifactStore) maxFileBytes() int64 {
	return m.maxFile
}

func normalizeGlobs(globs []string) []string {
	out := make([]string, 0, len(globs))
	for _, glob := range globs {
		glob = strings.TrimSpace(glob)
		if glob != "" {
			out = append(out, glob)
		}
	}
	return out
}

// globRoot returns the longest literal directory prefix of a glob.
func globRoot(glob string) string {
	i := strings.IndexAny(glob, "*?[")
	if i < 0 {
		return path.Dir(glob)
	}
	prefix := glob[:i]
	if slash := strings.LastIndex(prefix, "/"); slash > 0 {
		prefix = prefix[:slash]
	}
	if prefix == "" {
		return "/workspace"
	}
	return strings.TrimRight(prefix, "/")
}

func matchesAnyGlob(filePath string, globs []string) bool {
	for _, glob := range globs {
		if matchGlob(glob, filePath) {
			return true
		}
	}
	return false
}

func matchGlob(pattern, name string) bool {
	regex := globToRegex(pattern)
	ok, err := regexp.MatchString(regex, name)
	return err == nil && ok
}

func globToRegex(pattern string) string {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(pattern); i++ {
		ch := pattern[i]
		switch ch {
		case '*':
			if i+1 < len(pattern) && pattern[i+1] == '*' {
				i++
				if i+1 < len(pattern) && pattern[i+1] == '/' {
					i++
					b.WriteString("(?:.*/)?")
				} else {
					b.WriteString(".*")
				}
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		default:
			b.WriteString(regexp.QuoteMeta(string(ch)))
		}
	}
	b.WriteString("$")
	return b.String()
}

func shellQuotePath(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func sanitizeName(name string) string {
	var b strings.Builder
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	if b.Len() == 0 {
		return "artifact"
	}
	return b.String()
}
