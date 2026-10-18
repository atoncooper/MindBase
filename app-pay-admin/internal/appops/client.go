// Package appops: app-pay internal 端点的 HTTP 客户端（退款复核工作台专用）。
//
// 请求经 APISIX key-auth（pay-ops consumer）→ 资金写只发生在 app-pay 端点
// （审计 JSONL / 状态机 / 审批表一致性都由 app-pay 保证），本客户端携带
// PAY_OPS_KEY 与控制台登录身份（operator）。错误体透传 {"detail": ...}。
package appops

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	baseURL string
	opsKey  string
	hc      *http.Client
}

func New(baseURL, opsKey string, timeoutSeconds int) *Client {
	if timeoutSeconds <= 0 {
		timeoutSeconds = 5
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		opsKey:  opsKey,
		hc:      &http.Client{Timeout: time.Duration(timeoutSeconds) * time.Second},
	}
}

// Enabled reports whether the refund-review workbench is usable
// (requires an ops key; the master switch is checked at the router).
func (c *Client) Enabled() bool { return c != nil && c.baseURL != "" && c.opsKey != "" }

// RefundRequest mirrors app-pay's GET /internal/pay/refund-requests JSON row.
type RefundRequest struct {
	OrderNo     string  `json:"order_no"`
	Maker       string  `json:"maker"`
	MakerReason string  `json:"maker_reason"`
	Status      string  `json:"status"`
	CreatedAt   string  `json:"created_at"`
	DecidedAt   *string `json:"decided_at"`
}

// ListRefundRequests proxies GET /internal/pay/refund-requests?status=...
func (c *Client) ListRefundRequests(ctx context.Context, status string) ([]RefundRequest, error) {
	var rows []RefundRequest
	if err := c.get(ctx, "/internal/pay/refund-requests?status="+status, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

// ConfirmRefund proxies POST /internal/pay/orders/{orderNo}/refund with
// confirm=true: the console operator rides as checker (app-pay enforces
// checker != maker server-side).
func (c *Client) ConfirmRefund(ctx context.Context, orderNo, operator, reason string) error {
	body := map[string]any{
		"reason":   reason,
		"operator": operator,
		"confirm":  true,
	}
	return c.post(ctx, "/internal/pay/orders/"+orderNo+"/refund", body)
}

// RejectRefund proxies POST /internal/pay/orders/{orderNo}/refund/reject.
func (c *Client) RejectRefund(ctx context.Context, orderNo, operator string) error {
	return c.post(ctx, "/internal/pay/orders/"+orderNo+"/refund/reject",
		map[string]any{"operator": operator})
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return err
	}
	return c.do(req, out)
}

func (c *Client) post(ctx context.Context, path string, body any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.do(req, nil)
}

func (c *Client) do(req *http.Request, out any) error {
	req.Header.Set("apikey", c.opsKey)
	resp, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode >= 300 {
		detail := strings.TrimSpace(string(raw))
		var parsed struct {
			Detail string `json:"detail"`
		}
		if json.Unmarshal(raw, &parsed) == nil && parsed.Detail != "" {
			detail = parsed.Detail
		}
		return fmt.Errorf("app-pay %d: %s", resp.StatusCode, detail)
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("parse app-pay response: %w", err)
		}
	}
	return nil
}
