// Package cloud — thin HTTP client for app-admin's ONE privileged call into
// app-cloud: the share-content review preview. app-admin deliberately holds
// NO MinIO credentials and never talks to object storage directly; app-cloud
// resolves the share scope + the user's content-review disclosure and returns
// either a short-lived INLINE presigned URL (pdf/image/audio/video) or a
// server-extracted plain-text rendition (documents), never a download.
package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ErrDisclosureRequired — legacy app-cloud (before reviewer-access policy)
// answered 409 when the user had not acknowledged the content-review
// disclosure. Current app-cloud allows reviewer previews regardless of that
// acknowledgment; the typed mapping is kept so a rolling upgrade against an
// older app-cloud still surfaces a precise message.
var ErrDisclosureRequired = errors.New("该分享未确认内容审核告知，无法预览")

// UpstreamError carries a 4xx reason from app-cloud (share revoked/expired,
// document not extractable, file too large, …) so the router can echo the
// precise message instead of collapsing it into a 500.
type UpstreamError struct {
	Status int
	Detail string
}

func (e *UpstreamError) Error() string { return e.Detail }

// Client talks to app-cloud's /internal/cloud/admin-review/* surface.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		token:   strings.TrimSpace(token),
		http:    &http.Client{Timeout: 15 * time.Second},
	}
}

// Enabled reports whether the review plane is wired (both base URL and token).
func (c *Client) Enabled() bool { return c != nil && c.baseURL != "" && c.token != "" }

// PreviewFile — GET /internal/cloud/admin-review/shares/{shareID}/files/
// {fileID}/preview. Errors surface as app-admin's {"detail"} contract.
func (c *Client) PreviewFile(shareID, fileID int64) (*PreviewGrant, error) {
	if !c.Enabled() {
		return nil, errors.New("content review preview is not configured")
	}
	url := fmt.Sprintf("%s/internal/cloud/admin-review/shares/%d/files/%d/preview",
		c.baseURL, shareID, fileID)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	// Credentials never enter logs; the token only rides this internal header.
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("X-Request-Id", fmt.Sprintf("admin-review-%d", time.Now().UnixNano()))

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("app-cloud review endpoint unreachable: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		msg := strings.TrimSpace(string(body))
		var envelope struct {
			Detail string `json:"detail"`
		}
		if json.Unmarshal(body, &envelope) == nil && strings.TrimSpace(envelope.Detail) != "" {
			msg = strings.TrimSpace(envelope.Detail)
		}
		if resp.StatusCode == http.StatusConflict {
			// The user never acknowledged the content-review disclosure —
			// surface as a typed error (existing console mapping).
			return nil, ErrDisclosureRequired
		}
		if resp.StatusCode >= 400 && resp.StatusCode < 500 {
			return nil, &UpstreamError{Status: resp.StatusCode, Detail: msg}
		}
		return nil, fmt.Errorf("app-cloud review endpoint: HTTP %d: %s",
			resp.StatusCode, msg)
	}
	var grant PreviewGrant
	if err := json.Unmarshal(body, &grant); err != nil {
		return nil, fmt.Errorf("app-cloud review endpoint: bad payload: %w", err)
	}
	// Text previews intentionally carry no URL (no object link ever reaches
	// the browser); every other mode must be a presigned inline grant.
	if grant.ViewMode == "text" {
		if strings.TrimSpace(grant.Text) == "" {
			return nil, errors.New("app-cloud review endpoint: empty text preview")
		}
	} else if grant.URL == "" {
		return nil, errors.New("app-cloud review endpoint: empty preview url")
	}
	return &grant, nil
}

// PreviewGrant mirrors app-cloud's response shape: a presigned inline grant
// (url) for media/pdf, or an extracted plain-text rendition for documents.
type PreviewGrant struct {
	URL       string `json:"url"`
	ViewMode  string `json:"viewMode"`
	MimeType  string `json:"mimeType"`
	FileName  string `json:"fileName"`
	FileSize  int64  `json:"fileSize"`
	ExpiresIn int    `json:"expiresIn"`
	Text      string `json:"text,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}
