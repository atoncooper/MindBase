// Package cloud is app-user's M2M client for app-cloud object storage.
// The account domain owns profile metadata; app-cloud owns MinIO and exposes
// /internal/cloud/avatar for upload + read. app-user never holds MinIO creds.
package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type AvatarClient struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

func NewAvatarClient(baseURL, apiKey string, timeout time.Duration) *AvatarClient {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &AvatarClient{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		apiKey:  strings.TrimSpace(apiKey),
		http:    &http.Client{Timeout: timeout},
	}
}

func (c *AvatarClient) Enabled() bool { return c != nil && c.baseURL != "" && c.apiKey != "" }

// Upload stores the avatar bytes in app-cloud and returns the object key.
func (c *AvatarClient) Upload(ctx context.Context, uid int64, data []byte, contentType string) (string, error) {
	if !c.Enabled() {
		return "", fmt.Errorf("app-cloud avatar storage disabled")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/internal/cloud/avatar?uid="+strconv.FormatInt(uid, 10), bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("apikey", c.apiKey)
	req.Header.Set("X-Uid", fmt.Sprintf("%d", uid))
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("app-cloud avatar upload failed: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var out struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.Key == "" {
		return "", fmt.Errorf("app-cloud avatar upload returned no key")
	}
	return out.Key, nil
}

// Get reads the avatar bytes back through app-cloud.
func (c *AvatarClient) Get(ctx context.Context, uid int64, key string) (string, []byte, error) {
	if !c.Enabled() {
		return "", nil, fmt.Errorf("app-cloud avatar storage disabled")
	}
	u := c.baseURL + "/internal/cloud/avatar?uid=" + strconv.FormatInt(uid, 10) + "&key=" + url.QueryEscape(key)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("apikey", c.apiKey)
	req.Header.Set("X-Uid", fmt.Sprintf("%d", uid))
	resp, err := c.http.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if err != nil {
		return "", nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return "", nil, fmt.Errorf("app-cloud avatar read failed: %s", resp.Status)
	}
	return resp.Header.Get("Content-Type"), data, nil
}
