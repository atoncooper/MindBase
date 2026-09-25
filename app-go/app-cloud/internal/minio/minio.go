// Package minio wraps minio-go for the cloud drive: multipart presigned
// uploads, presigned GET with response-content-type override, and the
// browser-reachable public URL rewrite (nginx /minio-proxy Host contract).
package minio

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"app-cloud/internal/config"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
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

// resolvePublicBase mirrors the Python _resolve_public_base fallback chain:
// public_endpoint → {scheme}://{public_host}/minio-proxy → http://localhost/minio-proxy.
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
	return "http://localhost/minio-proxy"
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
func (c *Client) PresignGet(ctx context.Context, objectKey, responseContentType string, expireSeconds int) (string, error) {
	if expireSeconds <= 0 {
		expireSeconds = c.cfg.PresignExpire
	}
	qp := url.Values{}
	if responseContentType != "" {
		qp.Set("response-content-type", responseContentType)
	}
	u, err := c.sdk.Presign(ctx, "GET", c.cfg.Bucket, objectKey,
		time.Duration(expireSeconds)*time.Second, qp)
	if err != nil {
		return "", err
	}
	return c.publicURL(u.String()), nil
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
	Key  string
	Size int64
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
			ch <- ObjectInfo{Key: obj.Key, Size: obj.Size}
		}
	}()
	return ch
}

// Exists reports whether an object is readable (reconciliation missing check).
func (c *Client) Exists(ctx context.Context, objectKey string) bool {
	_, err := c.sdk.StatObject(ctx, c.cfg.Bucket, objectKey, minio.StatObjectOptions{})
	return err == nil
}

// DeleteObject removes one object (purge path).
func (c *Client) DeleteObject(ctx context.Context, objectKey string) error {
	return c.sdk.RemoveObject(ctx, c.cfg.Bucket, objectKey, minio.RemoveObjectOptions{})
}
