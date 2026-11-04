// Package payops: HTTP client for app-pay's internal operations endpoints
// (退款复核工作台专用). Migrated from app-pay-admin/internal/appops when the
// standalone pay console was merged into app-admin.
//
// 请求经 APISIX key-auth（pay-ops consumer）→ 资金写只发生在 app-pay 端点
// （审计 JSONL / 状态机 / 审批表一致性都由 app-pay 保证），本客户端携带
// PAY_OPS_KEY 与控制台登录身份（operator）。错误体透传 {"detail": ...}。
package payops

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

// defaultTimeoutSeconds mirrors the contract's default (timeout 默认 5s).
const defaultTimeoutSeconds = 5

// Client proxies the two refund-review decisions to app-pay.
type Client struct {
	baseURL string
	opsKey  string
	hc      *http.Client
}

// New builds the client; timeoutSeconds <= 0 falls back to 5s.
func New(baseURL, opsKey string, timeoutSeconds int) *Client {
	if timeoutSeconds <= 0 {
		timeoutSeconds = defaultTimeoutSeconds
	}
	return &Client{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		opsKey:  strings.TrimSpace(opsKey),
		hc:      &http.Client{Timeout: time.Duration(timeoutSeconds) * time.Second},
	}
}

// Enabled reports whether the refund-review workbench is wired (base URL +
// ops key present; the master switch is checked by the router).
func (c *Client) Enabled() bool {
	return c != nil && c.baseURL != "" && c.opsKey != ""
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

// ConfirmRefundOrReject dispatches approve/reject for the refund workbench.
//
//	confirm=true  -> POST refund (confirm=true, operator=checker)
//	confirm=false -> POST refund/reject (operator=checker)
func (c *Client) ConfirmRefundOrReject(ctx context.Context, orderNo, operator, reason string, confirm bool) error {
	if confirm {
		return c.ConfirmRefund(ctx, orderNo, operator, reason)
	}
	return c.RejectRefund(ctx, orderNo, operator)
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

// do sends the request with the ops key and maps a non-2xx answer onto a
// descriptive error carrying app-pay's {"detail": ...} verbatim.
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
