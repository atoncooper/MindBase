package service

import (
	"errors"
	"testing"
	"time"

	"app-task/internal/config"
	"app-task/internal/db"
	"app-task/internal/model"

	"github.com/resend/resend-go/v2"
)

// stubSender records sends and can fail on demand.
type stubSender struct{
	calls int
	fail  bool
}

func (s *stubSender) Send(req *resend.SendEmailRequest) (any, error) {
	s.calls++
	if s.fail {
		return nil, errors.New("resend 500")
	}
	return &resend.Email{}, nil
}

func emailCfg() *config.Config {
	cfg := &config.Config{}
	cfg.Email.Provider = "resend"
	cfg.Email.From = "MindBase <onboarding@resend.dev>"
	cfg.Notification.WorkerIntervalSeconds = 30
	cfg.Notification.RetryMax = 5
	cfg.Notification.RetryBackoffBase = 2
	return cfg
}

func TestEmailEnqueue(t *testing.T) {
	setupTestDB(t)
	svc := NewEmailService(emailCfg())
	id, err := svc.Enqueue([]string{"a@x.com"}, []string{"c@x.com"}, "S", "<p>hi</p>", "task-1")
	if err != nil || id == "" {
		t.Fatalf("Enqueue = %q, %v", id, err)
	}
	var m model.EmailMessage
	db.DB.Where("email_id = ?", id).First(&m)
	if m.Status != "pending" || m.Subject != "S" || m.ReferenceID != "task-1" {
		t.Fatalf("email = %+v", m)
	}
}

func TestEmailWorkerDryRun(t *testing.T) {
	setupTestDB(t)
	cfg := emailCfg()
	cfg.Email.APIKey = "" // no key → dry run
	svc := NewEmailService(cfg)
	id, _ := svc.Enqueue([]string{"a@x.com"}, nil, "S", "<p>hi</p>", "")
	svc.processBatch()
	var m model.EmailMessage
	db.DB.Where("email_id = ?", id).First(&m)
	if m.Status != "dry_run" {
		t.Fatalf("status = %q, want dry_run", m.Status)
	}
}

func TestEmailWorkerSend(t *testing.T) {
	setupTestDB(t)
	cfg := emailCfg()
	cfg.Email.APIKey = "re_test"
	sender := &stubSender{}
	svc := NewEmailService(cfg)
	svc.client = sender
	id, _ := svc.Enqueue([]string{"a@x.com"}, []string{"c@x.com"}, "S", "<p>hi</p>", "")
	svc.processBatch()
	var m model.EmailMessage
	db.DB.Where("email_id = ?", id).First(&m)
	if m.Status != "sent" || sender.calls != 1 {
		t.Fatalf("status = %q calls=%d, want sent/1", m.Status, sender.calls)
	}
}

func TestEmailWorkerRetryThenFail(t *testing.T) {
	setupTestDB(t)
	cfg := emailCfg()
	cfg.Email.APIKey = "re_test"
	cfg.Notification.RetryMax = 2
	sender := &stubSender{fail: true}
	svc := NewEmailService(cfg)
	svc.client = sender
	id, _ := svc.Enqueue([]string{"a@x.com"}, nil, "S", "<p>hi</p>", "")

	svc.processBatch()
	var m model.EmailMessage
	db.DB.Where("email_id = ?", id).First(&m)
	if m.Status != "pending" || m.RetryCount != 1 || m.NextRetryAt == nil {
		t.Fatalf("after 1st fail: %q retry=%d, want pending/1", m.Status, m.RetryCount)
	}

	// 强制重试窗口打开
	past := time.Now().UTC().Add(-time.Minute)
	db.DB.Model(&model.EmailMessage{}).Where("email_id = ?", id).Update("next_retry_at", past)
	svc.processBatch()
	db.DB.Where("email_id = ?", id).First(&m)
	if m.Status != "failed" || m.RetryCount != 2 {
		t.Fatalf("after retries exhausted: %q retry=%d, want failed/2", m.Status, m.RetryCount)
	}
}
