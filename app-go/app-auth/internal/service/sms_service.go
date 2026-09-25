package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"app-auth/internal/config"
)

// SMSService — Aliyun dysmsapi SendSms over direct HTTP with the ACS3
// (HMAC-SHA256) request signature. Implemented inline rather than via the
// official SDK to keep the binary lean; the canonical request follows the
// Alibaba Cloud "ACS3-HMAC-SHA256" signature spec (headers participate in
// the canonical form, empty-body GET for the RPC style).
type SMSService struct {
	cfg *config.Config
}

func NewSMSService(cfg *config.Config) *SMSService { return &SMSService{cfg: cfg} }

const smsEndpoint = "https://dysmsapi.aliyuncs.com"

var smsErrMessages = map[string]string{
	"isv.BUSINESS_LIMIT_CONTROL": "短信发送过于频繁，请稍后重试",
	"isv.SMS_SIGNATURE_ILLEGAL":  "短信签名未通过审核",
	"isv.SMS_TEMPLATE_ILLEGAL":   "短信模板未通过审核",
	"isv.AMOUNT_NOT_ENOUGH":      "短信余额不足",
	"isv.PHONE_NUMBER_ILLEGAL":   "手机号格式不正确",
	"isv.MOBILE_NUMBER_ILLEGAL":  "手机号格式不正确",
}

// SendSms sends a verification-code SMS. Disabled/unconfigured → error
// ("短信服务未启用"), which callers surface and /auth/features hides.
func (s *SMSService) SendSms(ctx context.Context, phone, code string) error {
	c := s.cfg.SMS
	if !c.Enabled {
		return fmt.Errorf("短信服务未启用")
	}
	if c.AccessKeyID == "" || c.AccessKeySecret == "" || c.SignName == "" || c.TemplateCode == "" {
		return fmt.Errorf("短信服务未配置")
	}
	tplParam, _ := json.Marshal(map[string]string{"code": code})

	params := url.Values{
		"PhoneNumbers":  {phone},
		"SignName":      {c.SignName},
		"TemplateCode":  {c.TemplateCode},
		"TemplateParam": {string(tplParam)},
	}
	req, err := signedACS3Get(ctx, smsEndpoint, params, "SendSms", "2017-05-25",
		c.AccessKeyID, c.AccessKeySecret)
	if err != nil {
		return fmt.Errorf("短信发送失败，请稍后重试")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req = req.WithContext(ctx)
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}
	resp, err := client.Do(req)
	if err != nil {
		slog.Error("[SMS] transport error", "phone", maskPhone(phone), "err", err)
		return fmt.Errorf("短信发送失败，请稍后重试")
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if err != nil {
		return fmt.Errorf("短信发送失败，请稍后重试")
	}
	var out struct {
		Code    string `json:"Code"`
		Message string `json:"Message"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		slog.Error("[SMS] invalid response", "phone", maskPhone(phone), "status", resp.StatusCode)
		return fmt.Errorf("短信发送失败，请稍后重试")
	}
	if out.Code != "" && out.Code != "OK" {
		msg := smsErrMessages[out.Code]
		if msg == "" {
			msg = "短信发送失败，请稍后重试"
		}
		slog.Warn("[SMS] rejected", "phone", maskPhone(phone), "code", out.Code, "message", out.Message)
		return fmt.Errorf("%s", msg)
	}
	slog.Info("[SMS] sent", "phone", maskPhone(phone))
	return nil
}

func maskPhone(phone string) string {
	if len(phone) >= 7 {
		return phone[:3] + "****" + phone[len(phone)-4:]
	}
	return "***"
}

// signedACS3Get builds a signed GET request per the ACS3 spec:
//
//	CanonicalRequest = METHOD \n URI \n CanonicalQuery \n CanonicalHeaders \n SignedHeaders \n HashedPayload
//	StringToSign     = "ACS3-HMAC-SHA256" \n sha256hex(CanonicalRequest)
func signedACS3Get(ctx context.Context, endpoint string, params url.Values,
	action, version, ak, sk string) (*http.Request, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	nonce, _ := randomToken(12)
	now := time.Now().UTC().Format("2006-01-02T15:04:05Z")

	headers := [][2]string{
		{"host", u.Host},
		{"x-acs-action", action},
		{"x-acs-version", version},
		{"x-acs-date", now},
		{"x-acs-signature-nonce", nonce},
	}
	sort.Slice(headers, func(i, j int) bool { return headers[i][0] < headers[j][0] })

	var ch strings.Builder
	var sh []string
	for _, h := range headers {
		ch.WriteString(h[0] + ":" + strings.TrimSpace(h[1]) + "\n")
		sh = append(sh, h[0])
	}
	// params get action/version in query as well (classic RPC form)
	q := url.Values{}
	for k, v := range params {
		q[k] = v
	}
	q.Set("Action", action)
	q.Set("Version", version)

	canonicalRequest := strings.Join([]string{
		http.MethodGet,
		"/",
		canonicalizeQuery(q),
		ch.String(),
		strings.Join(sh, ";"),
		sha256Hex(""),
	}, "\n")
	stringToSign := "ACS3-HMAC-SHA256\n" + sha256Hex(canonicalRequest)
	sig := hex.EncodeToString(hmacSHA256([]byte(sk), []byte(stringToSign)))

	u.RawQuery = canonicalizeQuery(q)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	for _, h := range headers {
		if h[0] != "host" {
			req.Header.Set(h[0], h[1])
		}
	}
	req.Header.Set("Authorization", fmt.Sprintf(
		"ACS3-HMAC-SHA256 Credential=%s,SignedHeaders=%s,Signature=%s",
		ak, strings.Join(sh, ";"), sig))
	return req, nil
}

// canonicalizeQuery percent-encodes per RFC3986 (space=%20) and sorts by key.
func canonicalizeQuery(v url.Values) string {
	keys := make([]string, 0, len(v))
	for k := range v {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		for _, val := range v[k] {
			if b.Len() > 0 {
				b.WriteByte('&')
			}
			b.WriteString(escapeRFC3986(k))
			b.WriteByte('=')
			b.WriteString(escapeRFC3986(val))
		}
	}
	return b.String()
}

func escapeRFC3986(s string) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '.' || c == '_' || c == '~':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hexDigits[c>>4])
			b.WriteByte(hexDigits[c&0xF])
		}
	}
	return b.String()
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key, data []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(data)
	return m.Sum(nil)
}
