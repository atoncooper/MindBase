package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"app-auth/internal/config"
)

// EmailService — Resend HTTP API client (the only place that knows Resend).
type EmailService struct {
	cfg *config.Config
}

func NewEmailService(cfg *config.Config) *EmailService { return &EmailService{cfg: cfg} }

const resendAPIURL = "https://api.resend.com/emails"

var purposeLabels = map[string]string{
	"bind_email":     "绑定邮箱",
	"reset_password": "重置密码",
	"twofa":          "二次验证",
	"register":       "注册",
}

// SendVerificationCode sends a numeric code (or a reset token for
// purpose=reset_password) via Resend. Disabled → no-op warning (parity).
func (s *EmailService) SendVerificationCode(ctx context.Context, toEmail, code, purpose string) error {
	if !s.cfg.Email.Enabled {
		slog.Warn("[EMAIL] disabled (email.enabled=false); skipping send", "to", toEmail)
		return nil
	}
	apiKey := s.cfg.Email.APIKey
	if apiKey == "" {
		return fmt.Errorf("邮件服务未配置 API Key")
	}
	subject, body := renderEmailTemplate(code, purpose, s.cfg.Email.FrontendURL)
	payload, _ := json.Marshal(map[string]any{
		"from":    s.cfg.Email.FromEmail,
		"to":      []string{toEmail},
		"subject": subject,
		"html":    body,
	})
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, resendAPIURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}
	resp, err := client.Do(req)
	if err != nil {
		slog.Error("[EMAIL] transport error", "to", toEmail, "err", err)
		return fmt.Errorf("邮件发送失败，请稍后重试")
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		slog.Error("[EMAIL] resend rejected", "status", resp.StatusCode, "body", string(body))
		return fmt.Errorf("邮件发送失败，请稍后重试")
	}
	slog.Info("[EMAIL] sent", "to", toEmail, "purpose", purpose)
	return nil
}

func renderEmailTemplate(code, purpose, frontendURL string) (string, string) {
	label := purposeLabels[purpose]
	if label == "" {
		label = "验证"
	}
	subject := fmt.Sprintf("【MindBase】您的%s验证码", label)

	if purpose == "reset_password" {
		link := fmt.Sprintf("%s/reset-password?token=%s", frontendURL, code)
		body := fmt.Sprintf(`
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#202124;">
  <h2 style="margin:0 0 16px 0;">重置您的 MindBase 密码</h2>
  <p style="margin:0 0 12px 0;">点击下方按钮设置新密码，链接 10 分钟内有效：</p>
  <p style="margin:24px 0;"><a href="%s" style="display:inline-block;padding:12px 24px;background:#1a73e8;color:#fff;text-decoration:none;border-radius:6px;font-weight:500;">重置密码</a></p>
  <p style="margin:0 0 8px 0;color:#5f6368;font-size:13px;">如果按钮无法点击，请直接访问以下链接：</p>
  <p style="margin:0 0 24px 0;word-break:break-all;color:#1a73e8;font-size:13px;">%s</p>
  <p style="margin:0;color:#5f6368;font-size:13px;">如果这不是您本人的操作，请忽略此邮件。</p>
</div>`, link, link)
		return subject, body
	}

	body := fmt.Sprintf(`
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#202124;">
  <h2 style="margin:0 0 16px 0;">MindBase %s</h2>
  <p style="margin:0 0 12px 0;">您正在进行%s操作，验证码为：</p>
  <p style="margin:24px 0;font-size:32px;font-weight:600;letter-spacing:8px;color:#1a73e8;text-align:center;">%s</p>
  <p style="margin:0 0 24px 0;color:#5f6368;font-size:13px;">验证码 5 分钟内有效。如非本人操作，请忽略此邮件。</p>
</div>`, label, label, code)
	return subject, body
}
