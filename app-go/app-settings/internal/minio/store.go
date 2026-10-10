// Package minio — thin object-storage facade for wallpaper uploads. The
// handle is nil when no endpoint is configured and the wallpaper routes
// degrade to 503.
package minio

import (
	"context"
	"io"
	"time"

	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type Store struct {
	client *minio.Client
	bucket string
}

// New builds the store; (nil, nil) when endpoint is empty (feature disabled).
func New(endpoint, accessKey, secretKey, bucket string, secure bool) (*Store, error) {
	if endpoint == "" {
		return nil, nil
	}
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: secure,
	})
	if err != nil {
		return nil, err
	}
	return &Store{client: client, bucket: bucket}, nil
}

func (s *Store) Put(ctx context.Context, key string, data []byte, contentType string) error {
	if s == nil {
		return errDisabled
	}
	_, err := s.client.PutObject(ctx, s.bucket, key, io.NopCloser(strings.NewReader(string(data))), int64(len(data)),
		minio.PutObjectOptions{ContentType: contentType})
	return err
}

func (s *Store) Get(ctx context.Context, key string) (string, []byte, error) {
	if s == nil {
		return "", nil, errDisabled
	}
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
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

func (s *Store) Remove(ctx context.Context, key string) error {
	if s == nil {
		return errDisabled
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
}

var errDisabled = errDisabledError{}

type errDisabledError struct{}

func (errDisabledError) Error() string { return "minio disabled" }
