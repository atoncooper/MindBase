package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"app-user/internal/config"
	authsvc "app-user/internal/service/auth"
)

func smsTestConfig(provider, codeSource string) *config.AuthConfig {
	return &config.AuthConfig{
		Email: config.EmailConfig{CodeLength: 6, CodeTTLSeconds: 300, MaxVerifyAttempts: 5},
		SMS: config.SMSConfig{
			Enabled:         true,
			Provider:        provider,
			CodeSource:      codeSource,
			AccessKeyID:     "test-ak",
			AccessKeySecret: "test-sk",
			SignName:        "测试签名",
			TemplateCode:    "SMS_123456",
			SchemeName:      "测试方案",
			CountryCode:     "86",
			IntervalSeconds: 60,
			DuplicatePolicy: 1,
			AutoRetry:       1,
			TemplateParams:  map[string]string{"min": "5"},
		},
	}
}

// smsServer captures the signed GET query and answers with body.
func smsServer(t *testing.T, body string) (*httptest.Server, *url.Values) {
	t.Helper()
	var got url.Values
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.Query()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(ts.Close)
	return ts, &got
}

func TestDypnsSendLocalCode(t *testing.T) {
	ts, got := smsServer(t, `{"Code":"OK","Success":true,"Message":"成功","Model":{"BizId":"b-1"}}`)
	svc := authsvc.NewSMSServiceWithEndpoint(smsTestConfig("dypnsapi", "local"), ts.URL)
	if err := svc.SendSms(context.Background(), "13800138000", "123456", "login"); err != nil {
		t.Fatalf("send: %v", err)
	}
	q := *got
	checks := map[string]string{
		"Action":           "SendSmsVerifyCode",
		"Version":          "2017-05-25",
		"PhoneNumber":      "13800138000",
		"SignName":         "测试签名",
		"TemplateCode":     "SMS_123456",
		"SchemeName":       "测试方案",
		"CountryCode":      "86",
		"CodeLength":       "6",
		"ValidTime":        "300",
		"Interval":         "60",
		"DuplicatePolicy":  "1",
		"AutoRetry":        "1",
		"CodeType":         "1",
		"ReturnVerifyCode": "false",
	}
	for k, want := range checks {
		if q.Get(k) != want {
			t.Errorf("query %s = %q, want %q", k, q.Get(k), want)
		}
	}
	var tpl map[string]string
	if err := json.Unmarshal([]byte(q.Get("TemplateParam")), &tpl); err != nil {
		t.Fatalf("TemplateParam: %v", err)
	}
	if tpl["code"] != "123456" {
		t.Errorf("TemplateParam code = %q, want explicit local code", tpl["code"])
	}
	if tpl["min"] != "5" {
		t.Errorf("TemplateParam min = %q, want configured extra var", tpl["min"])
	}
}

func TestDypnsSendGeneratedCode(t *testing.T) {
	ts, got := smsServer(t, `{"Code":"OK","Success":true}`)
	svc := authsvc.NewSMSServiceWithEndpoint(smsTestConfig("dypnsapi", "aliyun"), ts.URL)
	if !svc.UsesAliyunGeneratedCode() {
		t.Fatal("UsesAliyunGeneratedCode = false")
	}
	if err := svc.SendSms(context.Background(), "13800138000", "ignored", "login"); err != nil {
		t.Fatalf("send: %v", err)
	}
	var tpl map[string]string
	if err := json.Unmarshal([]byte(got.Get("TemplateParam")), &tpl); err != nil {
		t.Fatalf("TemplateParam: %v", err)
	}
	if tpl["code"] != "##code##" {
		t.Errorf("TemplateParam code = %q, want ##code##", tpl["code"])
	}
}

func TestDypnsCheckCode(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantOK  bool
		wantErr string
	}{
		{"pass", `{"Code":"OK","Success":true,"Model":{"VerifyResult":"PASS"}}`, true, ""},
		{"mismatch", `{"Code":"OK","Success":true,"Model":{"VerifyResult":"UNKNOWN"}}`, false, ""},
		{"frequency", `{"Code":"FREQUENCY_FAIL","Message":"频率超限"}`, false, "频繁"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ts, got := smsServer(t, tc.body)
			svc := authsvc.NewSMSServiceWithEndpoint(smsTestConfig("dypnsapi", "aliyun"), ts.URL)
			ok, err := svc.CheckCode(context.Background(), "13800138000", "123456")
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want contains %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("check: %v", err)
			}
			if ok != tc.wantOK {
				t.Errorf("ok = %v, want %v", ok, tc.wantOK)
			}
			if got.Get("Action") != "CheckSmsVerifyCode" || got.Get("VerifyCode") != "123456" {
				t.Errorf("query = %v", *got)
			}
		})
	}
}

func TestDysmsProviderUnchanged(t *testing.T) {
	ts, got := smsServer(t, `{"Code":"OK","Message":"OK"}`)
	cfg := smsTestConfig("dysmsapi", "local")
	// The legacy API returns Code=OK without Success; the service treats it as sent.
	svc := authsvc.NewSMSServiceWithEndpoint(cfg, ts.URL)
	if err := svc.SendSms(context.Background(), "13800138000", "654321", "login"); err != nil {
		t.Fatalf("send: %v", err)
	}
	q := *got
	if q.Get("Action") != "SendSms" || q.Get("PhoneNumbers") != "13800138000" {
		t.Errorf("query = %v", q)
	}
	var tpl map[string]string
	_ = json.Unmarshal([]byte(q.Get("TemplateParam")), &tpl)
	if tpl["code"] != "654321" {
		t.Errorf("TemplateParam = %v", tpl)
	}
}

func TestDypnsErrorMapping(t *testing.T) {
	ts, _ := smsServer(t, `{"Code":"MOBILE_NUMBER_ILLEGAL","Message":"bad phone"}`)
	svc := authsvc.NewSMSServiceWithEndpoint(smsTestConfig("dypnsapi", "local"), ts.URL)
	err := svc.SendSms(context.Background(), "13800138000", "123456", "login")
	if err == nil || !strings.Contains(err.Error(), "手机号格式不正确") {
		t.Fatalf("err = %v, want phone-number mapping", err)
	}
}

func TestDypnsPerPurposeTemplate(t *testing.T) {
	cfg := smsTestConfig("dypnsapi", "local")
	cfg.SMS.TemplateCodes = map[string]string{
		"login":      "100001",
		"bind_phone": "100004",
		"twofa_sms":  "100005",
	}
	cases := []struct{ purpose, want string }{
		{"login", "100001"},
		{"bind_phone", "100004"},
		{"twofa_sms", "100005"},
		{"unknown", "SMS_123456"}, // fallback to template_code
	}
	for _, tc := range cases {
		t.Run(tc.purpose, func(t *testing.T) {
			ts, got := smsServer(t, `{"Code":"OK","Success":true}`)
			svc := authsvc.NewSMSServiceWithEndpoint(cfg, ts.URL)
			if err := svc.SendSms(context.Background(), "13800138000", "123456", tc.purpose); err != nil {
				t.Fatalf("send: %v", err)
			}
			if got.Get("TemplateCode") != tc.want {
				t.Errorf("TemplateCode = %q, want %q", got.Get("TemplateCode"), tc.want)
			}
		})
	}
}

func TestSMSConfiguredGate(t *testing.T) {
	cfg := smsTestConfig("dypnsapi", "local")
	if !cfg.SMS.Configured() {
		t.Fatal("complete SMS config must report configured")
	}
	for name, mutate := range map[string]func(*config.AuthConfig){
		"disabled":    func(c *config.AuthConfig) { c.SMS.Enabled = false },
		"no-key-id":   func(c *config.AuthConfig) { c.SMS.AccessKeyID = "" },
		"no-secret":   func(c *config.AuthConfig) { c.SMS.AccessKeySecret = "" },
		"no-sign":     func(c *config.AuthConfig) { c.SMS.SignName = "" },
		"no-template": func(c *config.AuthConfig) { c.SMS.TemplateCode = "" },
	} {
		t.Run(name, func(t *testing.T) {
			c := smsTestConfig("dypnsapi", "local")
			mutate(c)
			if c.SMS.Configured() {
				t.Errorf("%s: Configured() = true, want false", name)
			}
		})
	}
}
