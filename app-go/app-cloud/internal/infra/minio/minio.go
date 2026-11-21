// Package minio wraps minio-go for the cloud drive: multipart presigned
// uploads, presigned GET with response-content-type override, and the
// browser-reachable public URL rewrite (nginx /minio-proxy Host contract).
package minio

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"app-cloud/internal/config"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/minio/minio-go/v7/pkg/notification"
)

type Client struct {
	cfg    *config.MinioConfig
	sdk    *minio.Client
	core   *minio.Core
	public string // resolved browser-reachable base
}

func New(cfg *config.MinioConfig) (*Client, error) {
	endpoint := endpointHost(cfg.Endpoint)
	opts := &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: cfg.Secure,
		Region: cfg.Region,
	}
	sdk, err := minio.New(endpoint, opts)
	if err != nil {
		return nil, fmt.Errorf("minio new: %w", err)
	}
	core, err := minio.NewCore(endpoint, opts)
	if err != nil {
		return nil, fmt.Errorf("minio core new: %w", err)
	}
	c := &Client{cfg: cfg, sdk: sdk, core: core, public: resolvePublicBase(cfg)}
	return c, nil
}

func endpointHost(endpoint string) string {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" {
		return endpoint
	}
	return u.Host
}

// resolvePublicBase resolves the browser-reachable base for presigned URLs:
// public_endpoint → {scheme}://{public_host}/minio-proxy → "/minio-proxy"
// (same-origin relative). The relative fallback is deployment-shape agnostic:
// the presigned query is host-independent (nginx /minio-proxy/ re-writes the
// upstream Host to minio:9000, which the signature actually covers), so it
// works for visitors on localhost, the share domain, or the public IP alike.
// The old http://localhost fallback broke every non-localhost visitor.
func resolvePublicBase(cfg *config.MinioConfig) string {
	public := strings.TrimRight(strings.TrimSpace(cfg.PublicEndpoint), "/")
	if public != "" {
		return public
	}
	host := strings.Trim(strings.TrimSpace(cfg.PublicHost), "/")
	if host != "" {
		scheme := "http"
		if cfg.Secure {
			scheme = "https"
		}
		return scheme + "://" + host + "/minio-proxy"
	}
	return "/minio-proxy"
}

// CompletePart re-exports the SDK type so callers of
// CompleteMultipartUpload don't need the SDK import.
type CompletePart = minio.CompletePart

// Bucket returns the configured bucket name.
func (c *Client) Bucket() string { return c.cfg.Bucket }

// EnsureBucket creates the bucket when missing (idempotent).
func (c *Client) EnsureBucket(ctx context.Context) error {
	found, err := c.sdk.BucketExists(ctx, c.cfg.Bucket)
	if err != nil {
		return err
	}
	if found {
		return nil
	}
	return c.sdk.MakeBucket(ctx, c.cfg.Bucket, minio.MakeBucketOptions{Region: c.cfg.Region})
}

// publicURL rewrites an internal presigned URL to the browser-reachable base.
func (c *Client) publicURL(internal string) string {
	internalBase := strings.TrimRight(c.cfg.Endpoint, "/")
	if !strings.HasPrefix(internal, internalBase) {
		return internal
	}
	return c.public + internal[len(internalBase):]
}

// CreateMultipartUpload starts a multipart session for object_key.
func (c *Client) CreateMultipartUpload(ctx context.Context, objectKey string) (string, error) {
	return c.core.NewMultipartUpload(ctx, c.cfg.Bucket, objectKey, minio.PutObjectOptions{})
}

// EnsureBucketNotification installs the bucket notification rule that routes
// multipart-completion events to the app-cloud settlement webhook. Idempotent:
// MinIO replaces the bucket notification configuration on each call, so every
// boot converges on exactly one rule.
func (c *Client) EnsureBucketNotification(ctx context.Context) error {
	raw := strings.TrimSpace(c.cfg.WebhookARN)
	if raw == "" {
		return nil
	}
	arn, err := notification.NewArnFromString(raw)
	if err != nil {
		return fmt.Errorf("invalid webhook arn %q: %w", raw, err)
	}
	qc := notification.NewConfig(arn)
	qc.ID = "app-cloud-upload-settlement"
	qc.AddEvents(notification.ObjectCreatedCompleteMultipartUpload)
	var conf notification.Configuration
	conf.AddQueue(qc)
	return c.sdk.SetBucketNotification(ctx, c.cfg.Bucket, conf)
}

// PresignUploadPart returns a browser-usable presigned PUT URL for one part.
func (c *Client) PresignUploadPart(ctx context.Context, objectKey, uploadID string, partNumber int) (string, error) {
	u, err := c.sdk.Presign(ctx, "PUT", c.cfg.Bucket, objectKey,
		time.Duration(c.cfg.PresignExpire)*time.Second,
		url.Values{
			"uploadId":   {uploadID},
			"partNumber": {fmt.Sprintf("%d", partNumber)},
		})
	if err != nil {
		return "", err
	}
	return c.publicURL(u.String()), nil
}

// CompleteMultipartUpload finalises the upload and returns the object ETag.
func (c *Client) CompleteMultipartUpload(ctx context.Context, objectKey, uploadID string,
	parts []minio.CompletePart) (string, error) {
	result, err := c.core.CompleteMultipartUpload(ctx, c.cfg.Bucket, objectKey, uploadID, parts, minio.PutObjectOptions{})
	if err != nil {
		return "", err
	}
	return strings.Trim(result.ETag, "\""), nil
}

// AbortMultipartUpload cancels an in-flight upload (best-effort).
func (c *Client) AbortMultipartUpload(ctx context.Context, objectKey, uploadID string) {
	_ = c.core.AbortMultipartUpload(ctx, c.cfg.Bucket, objectKey, uploadID)
}

// PresignGet returns a browser-usable presigned GET URL. responseContentType,
// when non-empty, is signed into the query (response-content-type) so the
// object renders inline regardless of its stored Content-Type — required
// under nginx nosniff for PDFs/media persisted as application/octet-stream.
// contentDisposition, when non-empty, is signed into the query
// (response-content-disposition) — "attachment" forces browsers to download
// instead of rendering attacker-controlled HTML/SVG on the app origin.
func (c *Client) PresignGet(ctx context.Context, objectKey, responseContentType, contentDisposition string, expireSeconds int) (string, error) {
	if expireSeconds <= 0 {
		expireSeconds = c.cfg.PresignExpire
	}
	qp := url.Values{}
	if responseContentType != "" {
		qp.Set("response-content-type", responseContentType)
	}
	if contentDisposition != "" {
		qp.Set("response-content-disposition", contentDisposition)
	}
	u, err := c.sdk.Presign(ctx, "GET", c.cfg.Bucket, objectKey,
		time.Duration(expireSeconds)*time.Second, qp)
	if err != nil {
		return "", err
	}
	return c.publicURL(u.String()), nil
}

// PutObject stores a small object with an explicit content type (avatar upload).
func (c *Client) PutObject(ctx context.Context, objectKey string, data []byte, contentType string) error {
	_, err := c.sdk.PutObject(ctx, c.cfg.Bucket, objectKey,
		bytes.NewReader(data), int64(len(data)),
		minio.PutObjectOptions{ContentType: contentType})
	return err
}

// GetObjectWithType downloads a small object and returns its stored content type.
func (c *Client) GetObjectWithType(ctx context.Context, objectKey string) (string, []byte, error) {
	obj, err := c.sdk.GetObject(ctx, c.cfg.Bucket, objectKey, minio.GetObjectOptions{})
	if err != nil {
		return "", nil, err
	}
	defer obj.Close()
	stat, err := obj.Stat()
	if err != nil {
		return "", nil, err
	}
	data, err := io.ReadAll(obj)
	if err != nil {
		return "", nil, err
	}
	return stat.ContentType, data, nil
}

// GetObject downloads the whole object into memory (pipeline + inline text
// preview only — small documents; the router caps size before calling).
func (c *Client) GetObject(ctx context.Context, objectKey string) ([]byte, error) {
	obj, err := c.sdk.GetObject(ctx, c.cfg.Bucket, objectKey, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer obj.Close()
	return io.ReadAll(obj)
}

// ObjectInfo is the listing projection used by reconciliation.
type ObjectInfo struct {
	Key          string
	Size         int64
	LastModified time.Time
}

// ListPrefix streams objects under a prefix (server-side efficient; bounded
// to the user's own namespace — this is NOT a bucket-wide scan).
func (c *Client) ListPrefix(ctx context.Context, prefix string) <-chan ObjectInfo {
	ch := make(chan ObjectInfo)
	go func() {
		defer close(ch)
		for obj := range c.sdk.ListObjects(ctx, c.cfg.Bucket, minio.ListObjectsOptions{
			Prefix:    prefix,
			Recursive: true,
		}) {
			ch <- ObjectInfo{Key: obj.Key, Size: obj.Size, LastModified: obj.LastModified}
		}
	}()
	return ch
}

// Exists reports whether an object is readable (reconciliation missing check).
func (c *Client) Exists(ctx context.Context, objectKey string) bool {
	_, err := c.sdk.StatObject(ctx, c.cfg.Bucket, objectKey, minio.StatObjectOptions{})
	return err == nil
}

// ObjectSize returns the stored object's size. Used right after multipart
// complete: the declared file_size is client input from init — the only size
// that may count toward quota accounting is what actually landed in storage.
func (c *Client) ObjectSize(ctx context.Context, objectKey string) (int64, error) {
	info, err := c.sdk.StatObject(ctx, c.cfg.Bucket, objectKey, minio.StatObjectOptions{})
	if err != nil {
		return 0, err
	}
	return info.Size, nil
}

// RemoveObjects batch-deletes keys (MinIO supports up to 1000 per request).
func (c *Client) RemoveObjects(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	objects := make(chan minio.ObjectInfo)
	errCh := c.sdk.RemoveObjects(ctx, c.cfg.Bucket, objects, minio.RemoveObjectsOptions{})
	go func() {
		defer close(objects)
		for _, k := range keys {
			objects <- minio.ObjectInfo{Key: k}
		}
	}()
	var firstErr error
	for e := range errCh {
		if e.Err != nil && firstErr == nil {
			firstErr = e.Err
		}
	}
	return firstErr
}

// DeleteObject removes one object (purge path).
func (c *Client) DeleteObject(ctx context.Context, objectKey string) error {
	return c.sdk.RemoveObject(ctx, c.cfg.Bucket, objectKey, minio.RemoveObjectOptions{})
}

// DownloadToFile streams one object to a local path. HLS packaging uses this
// instead of GetObject so multi-GB source videos are never loaded into RAM.
func (c *Client) DownloadToFile(ctx context.Context, objectKey, path string) error {
	obj, err := c.sdk.GetObject(ctx, c.cfg.Bucket, objectKey, minio.GetObjectOptions{})
	if err != nil {
		return err
	}
	defer obj.Close()

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	dst, err := os.Create(path)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, obj); err != nil {
		_ = dst.Close()
		return err
	}
	return dst.Close()
}

// UploadFile uploads one local file with an explicit content type (HLS
// playlist/segment uploads). The object key is relative to the drive bucket.
func (c *Client) UploadFile(ctx context.Context, objectKey, path, contentType string) error {
	_, err := c.sdk.FPutObject(ctx, c.cfg.Bucket, objectKey, path, minio.PutObjectOptions{
		ContentType: contentType,
	})
	return err
}

// EnsurePublicPrefix makes only the given bucket prefix anonymously readable.
// HLS assets are fetched by OpenResty without a MinIO presign; the edge checks
// the short-lived hls_token before proxying.
//
// The grant is additionally scoped to allowedSourceCIDRs (the edge network) so
// that a leaked MinIO address cannot be used to read HLS objects from outside
// the cluster. Statements targeting the same resource that were written by an
// older (unscoped) version are replaced, so an upgrade tightens the policy
// instead of leaving the permissive grant behind. Unrelated statements in an
// existing bucket policy are preserved.
func (c *Client) EnsurePublicPrefix(ctx context.Context, prefix string, allowedSourceCIDRs []string) error {
	cleanPrefix := strings.Trim(strings.TrimSpace(prefix), "/")
	if cleanPrefix == "" {
		return fmt.Errorf("minio: empty public prefix")
	}
	resource := fmt.Sprintf("arn:aws:s3:::%s/%s/*", c.cfg.Bucket, cleanPrefix)
	ourStatement := map[string]any{
		"Effect":    "Allow",
		"Principal": map[string]any{"AWS": []string{"*"}},
		"Action":    []string{"s3:GetObject"},
		"Resource":  []string{resource},
	}
	if len(allowedSourceCIDRs) > 0 {
		ourStatement["Condition"] = map[string]any{
			"IpAddress": map[string]any{"aws:SourceIp": allowedSourceCIDRs},
		}
	}
	policy := map[string]any{
		"Version":   "2012-10-17",
		"Statement": []any{ourStatement},
	}
	existing, err := c.sdk.GetBucketPolicy(ctx, c.cfg.Bucket)
	if err == nil && strings.TrimSpace(existing) != "" {
		var prior map[string]any
		if err := json.Unmarshal([]byte(existing), &prior); err != nil {
			return fmt.Errorf("minio: parse existing bucket policy: %w", err)
		}
		if stmts, ok := prior["Statement"].([]any); ok {
			for _, st := range stmts {
				if policyTargetsResource(st, resource) {
					continue // superseded (possibly unscoped) grant for this prefix
				}
				policy["Statement"] = append(policy["Statement"].([]any), st)
			}
		}
	}
	body, err := json.Marshal(policy)
	if err != nil {
		return err
	}
	return c.sdk.SetBucketPolicy(ctx, c.cfg.Bucket, string(body))
}

// policyTargetsResource reports whether a bucket-policy statement grants (or
// restricts) exactly the given object resource.
func policyTargetsResource(statement any, resource string) bool {
	st, ok := statement.(map[string]any)
	if !ok {
		return false
	}
	switch r := st["Resource"].(type) {
	case string:
		return r == resource
	case []any:
		for _, v := range r {
			if s, ok := v.(string); ok && s == resource {
				return true
			}
		}
	}
	return false
}
