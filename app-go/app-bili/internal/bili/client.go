// Package bili — the Bilibili API client with hardened anti-crawl posture:
// full device fingerprint (buvid3/buvid4 via the spi endpoint, bili_ticket),
// WBI-signed requests with rotation-aware keys, risk-control detection
// (HTTP 412 / code -352) with exponential backoff + jitter, per-account
// request pacing, and an optional static egress proxy.
//
// Legitimacy note: the client only ever syncs the LINKED USER'S OWN favorites
// with that user's own logged-in cookies (user_oauth SESSDATA) — personal
// data access at web-client pacing, never account-wide scraping.
package bili

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"app-bili/internal/config"
)

const (
	apiBase      = "https://api.bilibili.com"
	passportBase = "https://passport.bilibili.com"
	userAgent    = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

// RiskError marks a risk-control response (412/352) after retries are spent.
type RiskError struct{ Status int }

func (e *RiskError) Error() string { return fmt.Sprintf("bilibili risk control (status=%d)", e.Status) }

// APIError is a non-zero code response from the bilibili API.
type APIError struct {
	Code    int
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("bilibili api code=%d: %s", e.Code, e.Message) }

// fingerprint is the device identity shared across clients (device-scoped,
// not account-scoped).
type fingerprint struct {
	Buvid3     string
	Buvid4     string
	BiliTicket string
	TicketAt   time.Time
}

var (
	fpMu       sync.Mutex
	sharedFP   *fingerprint
	sharedKeys = newWbiKeys()
)

// Credentials resolve to a ready client — port of
// app/services/auth/bilibili_credentials.py (10-min cache lives there).
type Client struct {
	cfg        *config.Config
	sessdata   string
	biliJct    string // csrf — empty for read flows (parity with Python)
	dedeUserID string
	mid        int64
	http       *http.Client
}

// NewClient builds one client for a linked account. biliJct may be empty
// (read flows); write flows (favorites move/clean) require it.
func NewClient(cfg *config.Config, sessdata, biliJct, dedeUserID string, mid int64) (*Client, error) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	transport := http.DefaultTransport
	if strings.TrimSpace(cfg.Bili.Proxy) != "" {
		u, perr := url.Parse(cfg.Bili.Proxy)
		if perr != nil {
			return nil, fmt.Errorf("invalid bili.proxy: %w", perr)
		}
		transport = &http.Transport{Proxy: http.ProxyURL(u)}
	}
	c := &Client{
		cfg:        cfg,
		sessdata:   sessdata,
		biliJct:    biliJct,
		dedeUserID: dedeUserID,
		mid:        mid,
		http: &http.Client{
			Timeout:   time.Duration(cfg.Bili.RequestTimeoutSec) * time.Second,
			Jar:       jar,
			Transport: transport,
		},
	}
	// Seed the auth cookies into the jar (web headers stay constant).
	seed := []*http.Cookie{
		{Name: "SESSDATA", Value: sessdata, Domain: ".bilibili.com", Path: "/"},
	}
	if biliJct != "" {
		seed = append(seed, &http.Cookie{Name: "bili_jct", Value: biliJct, Domain: ".bilibili.com", Path: "/"})
	}
	if dedeUserID != "" {
		seed = append(seed, &http.Cookie{Name: "DedeUserID", Value: dedeUserID, Domain: ".bilibili.com", Path: "/"})
	}
	u, _ := url.Parse(apiBase)
	jar.SetCookies(u, seed)
	return c, nil
}

// getFingerprint lazily acquires (and caches process-wide) the device
// fingerprint. The spi endpoint is anonymous; bili_ticket lives ~3 months.
func getFingerprint(ctx context.Context, cfg *config.Config) (*fingerprint, error) {
	fpMu.Lock()
	defer fpMu.Unlock()
	if sharedFP != nil && time.Since(sharedFP.TicketAt) < 24*time.Hour {
		return sharedFP, nil
	}
	client := &http.Client{Timeout: 15 * time.Second}
	if strings.TrimSpace(cfg.Bili.Proxy) != "" {
		if u, err := url.Parse(cfg.Bili.Proxy); err == nil {
			client.Transport = &http.Transport{Proxy: http.ProxyURL(u)}
		}
	}
	// spi 端点路径是 /x/frontend/finger/spi（frontend 后接斜杠）；曾误写为
	// frontend-finger → B 站 404 HTML → JSON 解析报 invalid character '<'，
	// 全部 B 站请求被指纹步骤卡死（2026-10-08 实测两路径行为后修正）。
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiBase+"/x/frontend/finger/spi", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var payload struct {
		Code int `json:"code"`
		Data struct {
			B3 string `json:"b_3"`
			B4 string `json:"b_4"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.Code != 0 {
		return nil, fmt.Errorf("spi fingerprint failed: code=%d err=%v", payload.Code, err)
	}
	// bili_ticket (GenWebTicket) — best effort; absence only lowers the
	// fingerprint quality, requests still work with buvid3 + full headers.
	ticket := fetchBiliTicket(ctx, client, payload.Data.B3)
	sharedFP = &fingerprint{
		Buvid3:     payload.Data.B3,
		Buvid4:     payload.Data.B4,
		BiliTicket: ticket,
		TicketAt:   time.Now(),
	}
	slog.Info("[BILI] device fingerprint acquired",
		"buvid3_len", len(payload.Data.B3), "buvid4_len", len(payload.Data.B4),
		"ticket", ticket != "")
	return sharedFP, nil
}

// fetchBiliTicket implements the GenWebTicket flow (RSA-encrypted payload is
// NOT required for the plain GET variant; B站 has rotated these endpoints
// before — failure degrades gracefully).
func fetchBiliTicket(ctx context.Context, client *http.Client, buvid3 string) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		apiBase+"/bapis/bilibili.com.bilibili_ticket.Ticket/GenWebTicket",
		nil)
	if err != nil {
		return ""
	}
	q := req.URL.Query()
	q.Set("key_id", "2")
	q.Set("hexsign", "") // web client sends the HMAC-signed payload; empty works for the legacy variant
	q.Set("csrf", buvid3)
	req.URL.RawQuery = q.Encode()
	req.Header.Set("User-Agent", userAgent)
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var payload struct {
		Code int `json:"code"`
		Data struct {
			Ticket string `json:"ticket"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &payload) != nil || payload.Code != 0 {
		return ""
	}
	return payload.Data.Ticket
}

// applyHeaders sets the constant web-consistent header set + fingerprint
// cookies. Every request goes through here (header uniformity is the point).
func (c *Client) applyHeaders(ctx context.Context, req *http.Request) error {
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Referer", "https://www.bilibili.com/")
	req.Header.Set("Origin", "https://www.bilibili.com")
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")

	fp, err := getFingerprint(ctx, c.cfg)
	if err != nil {
		return err // risk posture: no request without a fingerprint
	}
	existing := req.Cookies()
	for _, ck := range []*http.Cookie{
		{Name: "buvid3", Value: fp.Buvid3},
		{Name: "buvid4", Value: fp.Buvid4},
	} {
		if ck.Value != "" {
			req.AddCookie(ck)
		}
	}
	if fp.BiliTicket != "" {
		req.AddCookie(&http.Cookie{Name: "bili_ticket", Value: fp.BiliTicket})
	}
	_ = existing
	return nil
}

// doJSON performs one GET/POST with risk-control backoff. On 412/352 the
// request is retried with exponential backoff + jitter (up to max_retries);
// WBI-keyed failures invalidate the signing keys. form!=nil switches to POST
// x-www-form-urlencoded.
func (c *Client) doJSON(ctx context.Context, method, rawURL string, query url.Values, form url.Values, out any, wbi bool) error {
	maxRetries := c.cfg.Bili.MaxRetries
	if maxRetries < 1 {
		maxRetries = 1
	}
	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			base := c.cfg.Bili.BackoffBaseMS
			if base <= 0 {
				base = 1500
			}
			backoff := time.Duration(base) * time.Duration(1<<uint(attempt-1))
			backoff += time.Duration(rand.Int63n(int64(backoff) / 2)) // jitter
			slog.Warn("[BILI] risk control — backing off",
				"attempt", attempt, "backoff_ms", backoff.Milliseconds(), "url", rawURL,
				"err", lastErr)
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return ctx.Err()
			}
		}

		status, code, msg, body, err := c.once(ctx, method, rawURL, query, form, wbi)
		if err != nil {
			lastErr = err
			continue
		}
		if status == http.StatusPreconditionFailed || status == 352 || code == -352 {
			lastErr = &RiskError{Status: status}
			if wbi {
				sharedKeys.invalidate()
			}
			continue
		}
		if status < 200 || status >= 300 {
			return &APIError{Code: status, Message: fmt.Sprintf("HTTP %d", status)}
		}
		if code != 0 {
			return &APIError{Code: code, Message: msg}
		}
		if out != nil && len(body) > 0 {
			return json.Unmarshal(body, out)
		}
		return nil
	}
	return lastErr
}

// once performs exactly one request and returns (status, api code, message,
// body). wbi=true signs the query parameters first.
func (c *Client) once(ctx context.Context, method, rawURL string, query url.Values, form url.Values, wbi bool) (int, int, string, []byte, error) {
	if wbi {
		mixin, ok := sharedKeys.get()
		if !ok {
			navData, err := c.rawJSON(ctx, http.MethodGet, apiBase+"/x/web-interface/nav", nil)
			if err != nil {
				return 0, 0, "", nil, fmt.Errorf("fetch wbi keys: %w", err)
			}
			imgKey, subKey, kerr := extractWbiKeys(navData)
			if kerr != nil {
				return 0, 0, "", nil, kerr
			}
			sharedKeys.set(imgKey, subKey)
			mixin, _ = sharedKeys.get()
		}
		signed := signParams(mapStringify(query), mixin, time.Now())
		query = signed
	}

	u := rawURL
	if query != nil && len(query) > 0 {
		u += "?" + query.Encode()
	}
	var bodyReader io.Reader
	if form != nil {
		bodyReader = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, u, bodyReader)
	if err != nil {
		return 0, 0, "", nil, err
	}
	if err := c.applyHeaders(ctx, req); err != nil {
		return 0, 0, "", nil, err
	}
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return 0, 0, "", nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return resp.StatusCode, 0, "", nil, err
	}
	// [DEBUG-TEMP] 调查收藏夹空响应：打印实际请求与响应头 300 字节（Cookie 只列名）。
	cookieNames := make([]string, 0, len(req.Cookies()))
	for _, ck := range req.Cookies() {
		cookieNames = append(cookieNames, ck.Name)
	}
	head := body
	if len(head) > 300 {
		head = head[:300]
	}
	slog.Debug("[BILI] request trace", "url", u, "cookies", strings.Join(cookieNames, ","), "status", resp.StatusCode, "proto", resp.Proto, "body_head", string(head))

	// Non-JSON (risk-control HTML/empty) surfaces as its HTTP status.
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) > 0 && trimmed[0] != '{' && trimmed[0] != '[' {
		return resp.StatusCode, 0, "", body, nil
	}
	var envelope struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Msg     string          `json:"msg"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return resp.StatusCode, 0, "", body, nil
	}
	msg := envelope.Message
	if msg == "" {
		msg = envelope.Msg
	}
	return resp.StatusCode, envelope.Code, msg, body, nil
}

// rawJSON fetches and decodes the full envelope (used for /nav where the
// wbi_img lives inside a non-zero-code response).
func (c *Client) rawJSON(ctx context.Context, method, rawURL string, query url.Values) (map[string]any, error) {
	var payload map[string]any
	err := c.doJSON(ctx, method, rawURL, query, nil, &payload, false)
	return payload, err
}

func mapStringify(v url.Values) map[string]string {
	out := make(map[string]string, len(v))
	for k := range v {
		out[k] = v.Get(k)
	}
	return out
}

// SleepJitter pauses a random duration in [min,max] — the pacing primitive
// used between pagination calls and per-video work (B站 tolerates web-like
// pacing; bursts trip risk control).
func SleepJitter(ctx context.Context, minMS, maxMS int) {
	if maxMS < minMS {
		minMS, maxMS = maxMS, minMS
	}
	d := time.Duration(minMS)*time.Millisecond + time.Duration(rand.Int63n(int64(maxMS-minMS+1)))*time.Millisecond
	select {
	case <-time.After(d):
	case <-ctx.Done():
	}
}

// BV↔AV conversion (the Mongo video_id convention). Standard algorithm per
// bilibili-API-collect (2022+ alphabet, position swaps, mask + xor).
const (
	bvXorCode  = int64(23442827791579)
	bvMaskCode = int64(2251799813685247)
	bvAlphabet = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf"
)

// BVToAV converts BV1xx… to the numeric aid. Returns 0 on malformed input.
func BVToAV(bvid string) int64 {
	if len(bvid) != 12 || !strings.HasPrefix(bvid, "BV") {
		return 0
	}
	chars := []byte(bvid)
	chars[3], chars[9] = chars[9], chars[3]
	chars[4], chars[7] = chars[7], chars[4]
	var tmp int64
	for _, ch := range chars[3:] {
		idx := strings.IndexByte(bvAlphabet, ch)
		if idx < 0 {
			return 0
		}
		tmp = tmp*58 + int64(idx)
	}
	return (tmp & bvMaskCode) ^ bvXorCode
}

func pow58(n int) int64 {
	r := int64(1)
	for i := 0; i < n; i++ {
		r *= 58
	}
	return r
}

// fmtInt is a tiny helper for building query values.
func fmtInt(v int64) string { return strconv.FormatInt(v, 10) }
