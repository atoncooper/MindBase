package service

import (
	"app-user/internal/utils"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"app-user/internal/config"
)

// SMS endpoints. dysmsapi is the legacy 短信服务 (custom sign/template);
// dypnsapi is 号码认证服务 短信认证, which supports system-granted sign/template
// and free code verification via CheckSmsVerifyCode.
const (
	dysmsEndpoint = "https://dysmsapi.aliyuncs.com"
	dypnsEndpoint = "https://dypnsapi.aliyuncs.com"
)

// SMSService sends verification codes through Aliyun. Provider is selected by
// sms.provider: "dysmsapi" (default, backward compatible) or "dypnsapi".
type SMSService struct {
	cfg *config.AuthConfig
	// endpoint overrides the provider default (tests only).
	endpoint string
}

func NewSMSService(cfg *config.AuthConfig) *SMSService { return &SMSService{cfg: cfg} }

// NewSMSServiceWithEndpoint is a test seam: the same service talking to a
// local httptest server instead of the real Aliyun endpoint.
func NewSMSServiceWithEndpoint(cfg *config.AuthConfig, endpoint string) *SMSService {
	return &SMSService{cfg: cfg, endpoint: endpoint}
}

func (s *SMSService) provider() string {
	if strings.EqualFold(s.cfg.SMS.Provider, "dypnsapi") {
		return "dypnsapi"
	}
	return "dysmsapi"
}

// UsesAliyunGeneratedCode reports whether Dypnsapi generates AND verifies the
// code (TemplateParam "##code##" + CheckSmsVerifyCode). In this mode the code
// is never stored in our DB.
func (s *SMSService) UsesAliyunGeneratedCode() bool {
	return s.provider() == "dypnsapi" && strings.EqualFold(s.cfg.SMS.CodeSource, "aliyun")
}

func (s *SMSService) endpointFor(provider string) string {
	if s.endpoint != "" {
		return s.endpoint
	}
	if provider == "dypnsapi" {
		return dypnsEndpoint
	}
	return dysmsEndpoint
}

// aliyunAPIError carries the Aliyun Code so callers can make narrow decisions
// (e.g. template-parameter mismatch retry) without parsing message text.
type aliyunAPIError struct {
	Code    string
	Message string
}

func (e *aliyunAPIError) Error() string {
	if msg := smsErrMessages[e.Code]; msg != "" {
		return msg
	}
	return "短信发送失败，请稍后重试"
}

var smsErrMessages = map[string]string{
	// dysmsapi
	"isv.BUSINESS_LIMIT_CONTROL": "短信发送过于频繁，请稍后重试",
	"isv.SMS_SIGNATURE_ILLEGAL":  "短信签名未通过审核",
	"isv.SMS_TEMPLATE_ILLEGAL":   "短信模板未通过审核",
	"isv.AMOUNT_NOT_ENOUGH":      "短信余额不足",
	"isv.PHONE_NUMBER_ILLEGAL":   "手机号格式不正确",
	"isv.MOBILE_NUMBER_ILLEGAL":  "手机号格式不正确",
	// dypnsapi
	"MOBILE_NUMBER_ILLEGAL":  "手机号格式不正确",
	"BUSINESS_LIMIT_CONTROL": "短信发送过于频繁，请稍后重试",
	"FREQUENCY_FAIL":         "短信发送过于频繁，请稍后重试",
	"INVALID_PARAMETERS":     "短信参数不合法",
	"FUNCTION_NOT_OPENED":    "短信认证服务未开通",
}

// smsAPIResponse is the shared RPC response shape for SendSms and
// SendSmsVerifyCode / CheckSmsVerifyCode.
type smsAPIResponse struct {
	Code    string `json:"Code"`
	Message string `json:"Message"`
	Success bool   `json:"Success"`
	Model   struct {
		VerifyCode   string `json:"VerifyCode"`
		VerifyResult string `json:"VerifyResult"`
		BizId        string `json:"BizId"`
		OutId        string `json:"OutId"`
	} `json:"Model"`
}

// SendSms sends a verification-code SMS. Disabled/unconfigured → error
// ("短信服务未启用"), which callers surface and /auth/features hides.
func (s *SMSService) SendSms(ctx context.Context, phone, code, purpose string) error {
	c := s.cfg.SMS
	if !c.Enabled {
		return fmt.Errorf("短信服务未启用")
	}
	if c.AccessKeyID == "" || c.AccessKeySecret == "" || c.SignName == "" || c.TemplateCode == "" {
		return fmt.Errorf("短信服务未配置")
	}
	if s.provider() == "dypnsapi" {
		return s.sendDypnsVerifyCode(ctx, phone, code, purpose)
	}
	return s.sendDysmsCode(ctx, phone, code, purpose)
}

// templateFor returns the template configured for a business purpose, falling
// back to the single template_code when no per-purpose override exists.
func (s *SMSService) templateFor(purpose string) string {
	if tc := strings.TrimSpace(s.cfg.SMS.TemplateCodes[purpose]); tc != "" {
		return tc
	}
	return s.cfg.SMS.TemplateCode
}

// templateParamJSON merges configured extra template variables with the
// service-injected ${code}; templates with additional variables (e.g. ${min})
// must configure them via the YAML sms.template_params map.
func (s *SMSService) templateParamJSON(code string) string {
	return s.templateParamJSONWithExtras(code, true)
}

// templateParamJSONWithExtras optionally omits configured extra variables; the
// fallback path uses it when a template turns out not to contain them.
func (s *SMSService) templateParamJSONWithExtras(code string, extras bool) string {
	tpl := make(map[string]string, len(s.cfg.SMS.TemplateParams)+1)
	if extras {
		for k, v := range s.cfg.SMS.TemplateParams {
			tpl[k] = v
		}
	}
	tpl["code"] = code
	raw, _ := json.Marshal(tpl)
	return string(raw)
}

// sendDysmsCode is the legacy 短信服务 path: custom sign/template plus an
// explicit code that we generated and store locally.
func (s *SMSService) sendDysmsCode(ctx context.Context, phone, code, purpose string) error {
	c := s.cfg.SMS
	params := url.Values{
		"PhoneNumbers":  {phone},
		"SignName":      {c.SignName},
		"TemplateCode":  {s.templateFor(purpose)},
		"TemplateParam": {s.templateParamJSON(code)},
	}
	resp, err := s.callAliyun(ctx, s.endpointFor("dysmsapi"), "SendSms", params)
	if err != nil {
		return err
	}
	// Legacy SendSms returns Code=OK without the Success flag.
	if !resp.Success && resp.Code != "OK" {
		slog.Warn("[SMS] dysmsapi rejected", "phone", maskPhone(phone), "purpose", purpose,
			"template", s.templateFor(purpose), "code", resp.Code, "message", resp.Message)
		return fmt.Errorf("短信发送失败，请稍后重试")
	}
	slog.Info("[SMS] sent", "provider", "dysmsapi", "phone", maskPhone(phone))
	return nil
}

// sendDypnsVerifyCode uses 号码认证服务 短信认证 (赠送签名/模板 friendly).
// CodeSource=local sends our explicit code; CodeSource=aliyun sends
// "##code##" and lets Aliyun generate + verify it.
func (s *SMSService) sendDypnsVerifyCode(ctx context.Context, phone, code, purpose string) error {
	c := s.cfg.SMS
	codeValue := code
	if s.UsesAliyunGeneratedCode() {
		codeValue = "##code##"
	}
	validSeconds := s.cfg.Email.CodeTTLSeconds
	if validSeconds <= 0 {
		validSeconds = 300
	}
	codeLength := s.cfg.Email.CodeLength
	if codeLength < 4 || codeLength > 8 {
		codeLength = 6
	}
	params := url.Values{
		"PhoneNumber":      {phone},
		"SignName":         {c.SignName},
		"TemplateCode":     {s.templateFor(purpose)},
		"TemplateParam":    {s.templateParamJSON(codeValue)},
		"CountryCode":      {c.CountryCode},
		"CodeLength":       {strconv.Itoa(codeLength)},
		"ValidTime":        {strconv.Itoa(validSeconds)},
		"Interval":         {strconv.Itoa(c.IntervalSeconds)},
		"DuplicatePolicy":  {strconv.Itoa(c.DuplicatePolicy)},
		"AutoRetry":        {strconv.Itoa(c.AutoRetry)},
		"CodeType":         {"1"},
		"ReturnVerifyCode": {"false"}, // never expose the code in the API response/log
	}
	if c.SchemeName != "" {
		params.Set("SchemeName", c.SchemeName)
	}
	resp, err := s.callAliyun(ctx, s.endpointFor("dypnsapi"), "SendSmsVerifyCode", params)
	// Some donated templates only contain ${code}; others also require ${min}.
	// On a parameter-mismatch error, retry once without our extra variables.
	var apiErr *aliyunAPIError
	if err != nil && errors.As(err, &apiErr) && apiErr.Code == "isv.INVALID_PARAMETERS" && len(c.TemplateParams) > 0 {
		slog.Warn("[SMS] retry without extra template params", "phone", maskPhone(phone), "purpose", purpose)
		params.Set("TemplateParam", s.templateParamJSONWithExtras(codeValue, false))
		resp, err = s.callAliyun(ctx, s.endpointFor("dypnsapi"), "SendSmsVerifyCode", params)
	}
	if err != nil {
		return err
	}
	if !resp.Success && resp.Code != "OK" {
		slog.Warn("[SMS] dypnsapi rejected", "phone", maskPhone(phone), "purpose", purpose,
			"template", s.templateFor(purpose), "code", resp.Code, "message", resp.Message)
		return fmt.Errorf("短信发送失败，请稍后重试")
	}
	slog.Info("[SMS] sent", "provider", "dypnsapi", "phone", maskPhone(phone),
		"generated", s.UsesAliyunGeneratedCode(), "biz_id", resp.Model.BizId)
	return nil
}

// CheckCode verifies a code with Dypnsapi CheckSmsVerifyCode. It is only used
// when CodeSource=aliyun (the code was generated by Aliyun); returns
// (false, nil) for a mismatch and an error only for transport/service failures.
func (s *SMSService) CheckCode(ctx context.Context, phone, code string) (bool, error) {
	c := s.cfg.SMS
	params := url.Values{
		"PhoneNumber": {phone},
		"VerifyCode":  {code},
		"CountryCode": {c.CountryCode},
	}
	if c.SchemeName != "" {
		params.Set("SchemeName", c.SchemeName)
	}
	resp, err := s.callAliyun(ctx, s.endpointFor("dypnsapi"), "CheckSmsVerifyCode", params)
	if err != nil {
		return false, err
	}
	return resp.Model.VerifyResult == "PASS", nil
}

// callAliyun signs and executes one RPC-style Aliyun SMS request.
func (s *SMSService) callAliyun(ctx context.Context, endpoint, action string, params url.Values) (*smsAPIResponse, error) {
	req, err := signedACS3Get(ctx, endpoint, params, action, "2017-05-25",
		s.cfg.SMS.AccessKeyID, s.cfg.SMS.AccessKeySecret)
	if err != nil {
		return nil, fmt.Errorf("短信发送失败，请稍后重试")
	}
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req = req.WithContext(reqCtx)
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}
	resp, err := client.Do(req)
	if err != nil {
		slog.Error("[SMS] transport error", "action", action, "err", err)
		return nil, fmt.Errorf("短信发送失败，请稍后重试")
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if err != nil {
		return nil, fmt.Errorf("短信发送失败，请稍后重试")
	}
	var out smsAPIResponse
	if err := json.Unmarshal(body, &out); err != nil {
		slog.Error("[SMS] invalid response", "action", action, "status", resp.StatusCode)
		return nil, fmt.Errorf("短信发送失败，请稍后重试")
	}
	if out.Code != "" && out.Code != "OK" {
		slog.Warn("[SMS] rejected", "action", action, "code", out.Code, "message", out.Message)
		return nil, &aliyunAPIError{Code: out.Code, Message: out.Message}
	}
	return &out, nil
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
	nonce, _ := utils.RandomToken(12)
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
