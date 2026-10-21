// KgClient — HTTP client for app-kg's internal cloud-doc routing endpoints
// (L1 graph writes). gRPC stays the app-ts face of app-kg; this module's
// Docker build context cannot import app-kg's internal kgpb, so the ingest
// side speaks internal JSON on app-kg's health mux instead. Best effort by
// contract: callers treat errors as non-fatal.
package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"app-cloud/internal/config"
)

type KgClient struct {
	base  string
	token string
	http  *http.Client
}

// NewKgClient builds the client; an empty base URL disables graph writes.
func NewKgClient(cfg config.KgConfig) *KgClient {
	return &KgClient{
		base:  strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/"),
		token: cfg.Token,
		http:  &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}},
	}
}

// Enabled reports whether a graph writer target is configured.
func (c *KgClient) Enabled() bool { return c != nil && c.base != "" }

func (c *KgClient) post(ctx context.Context, path string, body any) error {
	if c == nil || c.base == "" {
		return fmt.Errorf("kg client not configured")
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("X-Internal-Token", c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("kg http %d", resp.StatusCode)
	}
	return nil
}

func (c *KgClient) UpsertCloudDocGraph(ctx context.Context, uid int64, uploadUUID, title, contentHash string, topics, entities []string) error {
	return c.post(ctx, "/internal/kg/cloud-doc/upsert", map[string]any{
		"uid": uid, "upload_uuid": uploadUUID, "title": title,
		"content_hash": contentHash, "topics": topics, "entities": entities,
	})
}

func (c *KgClient) DeleteCloudDocGraph(ctx context.Context, uid int64, uploadUUID string) error {
	return c.post(ctx, "/internal/kg/cloud-doc/delete", map[string]any{
		"uid": uid, "upload_uuid": uploadUUID,
	})
}
