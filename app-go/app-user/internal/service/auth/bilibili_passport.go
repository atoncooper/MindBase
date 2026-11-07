package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"time"

	"github.com/skip2/go-qrcode"
)

// BilibiliPassport is a minimal B站 passport client for the login flow:
// QR generate/poll (passport.bilibili.com) and user info (nav). These
// endpoints need cookies only — no WBI signing — so the auth service stays
// independent of the backend's business B站 client.
type BilibiliPassport struct {
	client *http.Client
}

const bilibiliPassportURL = "https://passport.bilibili.com"
const bilibiliBaseURL = "https://api.bilibili.com"

var bilibiliHeaders = map[string]string{
	"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	"Referer":    "https://www.bilibili.com/",
	"Origin":     "https://www.bilibili.com",
}

func NewBilibiliPassport() *BilibiliPassport {
	jar, _ := cookiejar.New(nil)
	return &BilibiliPassport{
		client: &http.Client{
			Timeout:   30 * time.Second,
			Jar:       jar,
			Transport: &http.Transport{Proxy: http.ProxyFromEnvironment},
		},
	}
}

// NetPathError marks an outbound request that died on the network path —
// no HTTP answer was ever received. In this deployment container egress on
// ports 80/443 is transparently routed through the Docker Desktop proxy
// (http://127.0.0.1:10808, v2rayN); when that proxy is down every call fails
// with a bare EOF/reset, which previously surfaced as an opaque
// "bilibili request: ... EOF" and cost a debugging session to attribute.
type NetPathError struct {
	Endpoint string        // host + path only, query string stripped
	Elapsed  time.Duration // time-to-failure
	Kind     string        // eof | reset | refused | timeout | dns | other
	Err      error         // underlying transport error
}

func (e *NetPathError) Error() string {
	return fmt.Sprintf("outbound %s to %s failed after %s: %v",
		e.Kind, e.Endpoint, e.Elapsed.Round(time.Millisecond), e.Err)
}

func (e *NetPathError) Unwrap() error { return e.Err }

// Hint is the operator-facing diagnosis. Kept short and free of "/", "<",
// "\\" so it is also safe to surface as an API error detail (the frontend
// sanitizer accepts only marker-free details of at most 80 chars).
func (e *NetPathError) Hint() string {
	switch e.Kind {
	case "eof":
		return "出站连接被对端提前关闭（EOF），通常是宿主机代理未启动或中间设备切断连接"
	case "reset":
		return "出站连接被重置，常见于代理异常或防火墙切断连接"
	case "refused":
		return "出站连接被拒绝，代理端口未监听或目标不可达"
	case "timeout":
		return "出站请求超时，检查代理节点连通性"
	case "dns":
		return "DNS 解析失败，检查容器 DNS 配置"
	default:
		return "出站网络异常"
	}
}

// classifyNetErr inspects a transport error and tags it with a failure kind.
func classifyNetErr(endpoint string, elapsed time.Duration, err error) *NetPathError {
	kind := "other"
	msg := err.Error()
	var ne net.Error
	switch {
	case errors.As(err, &ne) && ne.Timeout():
		kind = "timeout"
	case errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		strings.Contains(msg, "EOF") || strings.Contains(msg, "unexpected eof"):
		kind = "eof"
	case strings.Contains(msg, "reset by peer"), strings.Contains(msg, "connection reset"):
		kind = "reset"
	case strings.Contains(msg, "connection refused"), strings.Contains(msg, "actively refused"):
		kind = "refused"
	case strings.Contains(msg, "no such host"), strings.Contains(msg, "lookup"):
		kind = "dns"
	}
	return &NetPathError{Endpoint: netEndpointLabel(endpoint), Elapsed: elapsed, Kind: kind, Err: err}
}

// netEndpointLabel strips the query string — qrcode keys are session-scoped
// credentials and follow the log-redaction stance of staying out of logs.
func netEndpointLabel(endpoint string) string {
	if i := strings.IndexByte(endpoint, '?'); i >= 0 {
		return endpoint[:i]
	}
	return endpoint
}

// QRGenerateResult is the GET /auth/qrcode payload.
type QRGenerateResult struct {
	QRCodeKey      string
	QRCodeURL      string
	QRCodeImageB64 string // data URL
}

// GenerateQRCode creates a login QR code and renders it as a PNG data URL.
func (p *BilibiliPassport) GenerateQRCode(ctx context.Context) (*QRGenerateResult, error) {
	var payload struct {
		Code int    `json:"code"`
		Msg  string `json:"message"`
		Data struct {
			QRCodeKey string `json:"qrcode_key"`
			URL       string `json:"url"`
		} `json:"data"`
	}
	if err := p.getJSON(ctx, bilibiliPassportURL+"/x/passport-login/web/qrcode/generate", nil, &payload); err != nil {
		return nil, err
	}
	if payload.Code != 0 {
		return nil, fmt.Errorf("生成二维码失败: %s", payload.Msg)
	}
	png, err := qrcode.Encode(payload.Data.URL, qrcode.Medium, 400)
	if err != nil {
		return nil, fmt.Errorf("render qrcode: %w", err)
	}
	return &QRGenerateResult{
		QRCodeKey:      payload.Data.QRCodeKey,
		QRCodeURL:      payload.Data.URL,
		QRCodeImageB64: "data:image/png;base64," + b64Encode(png),
	}, nil
}

// QRPollResult is the outcome of one poll call.
type QRPollResult struct {
	Status       string // waiting | scanned | confirmed | expired | unknown
	Message      string
	Cookies      map[string]string
	RefreshToken string
}

// PollQRCodeStatus checks the QR login state. On confirmed it collects the
// session cookies from (a) the client cookie jar and (b) the redirect URL
// query — parity with the Python implementation's three-source merge.
func (p *BilibiliPassport) PollQRCodeStatus(ctx context.Context, qrKey string) (*QRPollResult, error) {
	var payload struct {
		Code int    `json:"code"`
		Msg  string `json:"message"`
		Data struct {
			Code         int    `json:"code"`
			Message      string `json:"message"`
			URL          string `json:"url"`
			RefreshToken string `json:"refresh_token"`
		} `json:"data"`
	}
	endpoint := bilibiliPassportURL + "/x/passport-login/web/qrcode/poll?qrcode_key=" + url.QueryEscape(qrKey)
	if err := p.getJSON(ctx, endpoint, nil, &payload); err != nil {
		return nil, err
	}
	if payload.Code != 0 {
		return nil, fmt.Errorf("轮询二维码状态失败: %s", payload.Msg)
	}

	statusMap := map[int][2]string{
		86101: {"waiting", "等待扫码"},
		86090: {"scanned", "已扫码，等待确认"},
		86038: {"expired", "二维码已过期"},
		0:     {"confirmed", "登录成功"},
	}
	status, msg := "unknown", payload.Data.Message
	if m, ok := statusMap[payload.Data.Code]; ok {
		status, msg = m[0], m[1]
	}
	result := &QRPollResult{Status: status, Message: msg, Cookies: map[string]string{}}

	if status == "confirmed" {
		// (a) cookies accumulated in the jar across generate+poll calls
		u, _ := url.Parse(bilibiliPassportURL)
		for _, c := range p.client.Jar.Cookies(u) {
			result.Cookies[c.Name] = c.Value
		}
		// (b) cookies embedded in the redirect URL query string
		if payload.Data.URL != "" {
			if ru, err := url.Parse(payload.Data.URL); err == nil {
				for _, key := range []string{"SESSDATA", "bili_jct", "DedeUserID"} {
					if v := ru.Query().Get(key); v != "" {
						result.Cookies[key] = v
					}
				}
			}
		}
		result.RefreshToken = payload.Data.RefreshToken
	}
	return result, nil
}

// NavUserInfo is the subset of the nav payload the auth flows need.
type NavUserInfo struct {
	Mid   int64  `json:"mid"`
	Uname string `json:"uname"`
	Face  string `json:"face"`
}

// GetUserInfo fetches the logged-in user's profile via the nav endpoint.
// Empty biliJCT is fine — the Python side also sends bili_jct="".
func (p *BilibiliPassport) GetUserInfo(sessdata, biliJCT, dedeUserID string) (*NavUserInfo, error) {
	req, err := http.NewRequest(http.MethodGet, bilibiliBaseURL+"/x/web-interface/nav", nil)
	if err != nil {
		return nil, err
	}
	for k, v := range bilibiliHeaders {
		req.Header.Set(k, v)
	}
	if sessdata != "" {
		req.AddCookie(&http.Cookie{Name: "SESSDATA", Value: sessdata})
	}
	if biliJCT != "" {
		req.AddCookie(&http.Cookie{Name: "bili_jct", Value: biliJCT})
	}
	if dedeUserID != "" {
		req.AddCookie(&http.Cookie{Name: "DedeUserID", Value: dedeUserID})
	}
	client := &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return nil, classifyNetErr(bilibiliBaseURL+"/x/web-interface/nav", time.Since(start),
			fmt.Errorf("获取用户信息失败: %w", err))
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var payload struct {
		Code int          `json:"code"`
		Msg  string       `json:"message"`
		Data *NavUserInfo `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("获取用户信息失败: invalid json: %w", err)
	}
	if payload.Code != 0 || payload.Data == nil {
		return nil, fmt.Errorf("获取用户信息失败: %s", payload.Msg)
	}
	return payload.Data, nil
}

// getJSON performs a GET with the standard B站 headers and decodes JSON.
func (p *BilibiliPassport) getJSON(ctx context.Context, endpoint string, params url.Values, out any) error {
	if params != nil && len(params) > 0 {
		endpoint += "?" + params.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	for k, v := range bilibiliHeaders {
		req.Header.Set(k, v)
	}
	start := time.Now()
	resp, err := p.client.Do(req)
	if err != nil {
		return classifyNetErr(endpoint, time.Since(start),
			fmt.Errorf("bilibili request: %w", err))
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bilibili http status=%d body=%.200s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.Unmarshal(body, out)
}
