package cli

// HTTP client for the running app-task's /api/* console surface (and the
// service endpoints that accept console credentials). Credentials: the master
// token (webui.token) or a service API key (at_…) — both are accepted by the
// server's belt-and-braces middleware.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const defaultBaseURL = "http://127.0.0.1:8001"

type apiClient struct {
	base  string
	token string
	http  *http.Client
}

func newClient() (*apiClient, error) {
	base := flagURL
	if base == "" {
		base = strings.TrimSpace(os.Getenv("AT_URL"))
	}
	if base == "" {
		base = defaultBaseURL
	}
	base = strings.TrimRight(base, "/")

	token := flagToken
	if token == "" {
		token = strings.TrimSpace(os.Getenv("AT_TOKEN"))
	}
	if token == "" {
		token = strings.TrimSpace(os.Getenv("APPTASK__WEBUI__TOKEN"))
	}
	if token == "" {
		return nil, errors.New("缺少 API 凭据：用 --token 传入 master token 或服务面密钥（env AT_TOKEN / APPTASK__WEBUI__TOKEN）")
	}
	return &apiClient{
		base:  base,
		token: token,
		http:  &http.Client{Timeout: 60 * time.Second},
	}, nil
}

func (c *apiClient) do(method, path string, body any, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.base+path, rdr)
	if err != nil {
		return err
	}
	// Both headers: X-WebUI-Token authenticates the console surface (master
	// token); X-API-Key covers service endpoints when the credential is an
	// at_ service key. Unknown credentials fail exactly like the server does.
	req.Header.Set("X-WebUI-Token", c.token)
	req.Header.Set("X-API-Key", c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("连接 %s 失败：%v（服务在跑吗？at serve）", c.base, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		var e struct {
			Detail string `json:"detail"`
		}
		_ = json.Unmarshal(data, &e)
		if e.Detail == "" {
			e.Detail = strings.TrimSpace(string(data))
		}
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, e.Detail)
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("decode response: %w", err)
		}
	}
	return nil
}

func (c *apiClient) get(path string, out any) error { return c.do(http.MethodGet, path, nil, out) }

func (c *apiClient) post(path string, body, out any) error {
	return c.do(http.MethodPost, path, body, out)
}
