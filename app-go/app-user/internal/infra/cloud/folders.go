// Folder listing/creation over app-cloud's M2M face. The account domain
// provisions the per-user default drive folder ("agent/") when an account is
// created; app-cloud remains the authority for folder rows (MinIO/MySQL owner),
// so app-user only speaks the /internal/cloud/folders contract.
package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ensureFolderTimeout bounds one EnsureFolder round trip (list + create). The
// registration path calls this inline, so a slow or unreachable app-cloud must
// never hold a signup for longer than this.
const ensureFolderTimeout = 3 * time.Second

// FolderClient is app-user's M2M client for app-cloud folders.
type FolderClient struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

// NewFolderClient builds the client from the shared app-cloud config
// (base_url/api_key/timeout_ms). The timeout is clamped to ensureFolderTimeout
// because folder provisioning is a best-effort side effect, never a user wait.
func NewFolderClient(baseURL, apiKey string, timeout time.Duration) *FolderClient {
	if timeout <= 0 || timeout > ensureFolderTimeout {
		timeout = ensureFolderTimeout
	}
	return &FolderClient{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		apiKey:  strings.TrimSpace(apiKey),
		http:    &http.Client{Timeout: timeout},
	}
}

// Enabled reports whether the client can reach app-cloud (M2M key configured).
func (c *FolderClient) Enabled() bool { return c != nil && c.baseURL != "" && c.apiKey != "" }

// folderItem mirrors one row of GET /internal/cloud/folders.
type folderItem struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	ParentID *int64 `json:"parent_id"`
}

// EnsureFolder makes sure the user's root contains a folder named name and
// returns nil when it already exists. Matching is case-insensitive so an older
// client's "Agent" is not duplicated as "agent"; only one level (the root) is
// listed, which is exactly where registration creates the folder.
func (c *FolderClient) EnsureFolder(ctx context.Context, uid int64, name string) error {
	if !c.Enabled() {
		return fmt.Errorf("app-cloud folder service disabled")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("folder name is empty")
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, ensureFolderTimeout)
		defer cancel()
	}
	items, err := c.listRoot(ctx, uid)
	if err != nil {
		return err
	}
	for _, item := range items {
		if strings.EqualFold(strings.TrimSpace(item.Name), name) {
			return nil
		}
	}
	return c.createRoot(ctx, uid, name)
}

func (c *FolderClient) listRoot(ctx context.Context, uid int64) ([]folderItem, error) {
	endpoint := c.baseURL + "/internal/cloud/folders?uid=" + strconv.FormatInt(uid, 10)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	c.setHeaders(req, uid)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("app-cloud folder list failed: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var out struct {
		Items []folderItem `json:"items"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("app-cloud folder list returned invalid JSON: %w", err)
	}
	return out.Items, nil
}

func (c *FolderClient) createRoot(ctx context.Context, uid int64, name string) error {
	payload, err := json.Marshal(map[string]string{"name": name})
	if err != nil {
		return err
	}
	endpoint := c.baseURL + "/internal/cloud/folders?uid=" + strconv.FormatInt(uid, 10)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	c.setHeaders(req, uid)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("app-cloud folder create failed: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	return nil
}

// setHeaders sends the shared apikey plus X-Uid, matching the avatar M2M client.
// The internal guard reads the uid from the query string; X-Uid keeps the call
// self-describing in access logs.
func (c *FolderClient) setHeaders(req *http.Request, uid int64) {
	req.Header.Set("apikey", c.apiKey)
	req.Header.Set("X-Uid", strconv.FormatInt(uid, 10))
}
