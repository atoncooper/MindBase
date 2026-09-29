package service

import (
	"errors"
	"sync"
	"testing"
	"time"

	"app-task/internal/config"
	"app-task/internal/db"
	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/resend/resend-go/v2"
)

// stubSender records sends and can fail on demand.
type stubSender struct {
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

// ── 集群验收：邮件队列认领互斥（双 worker 并发，恰好发送一次）────────

func TestEmailClaimMutex(t *testing.T) {
	setupTestDB(t)
	svc := NewEmailService(emailCfg())
	id, _ := svc.Enqueue([]string{"a@x.com"}, nil, "S", "<p>hi</p>", "")

	_, w1, err1 := repo.ClaimEmail(id, time.Now().UTC())
	_, w2, err2 := repo.ClaimEmail(id, time.Now().UTC())
	if err1 != nil || err2 != nil {
		t.Fatalf("claim errors: %v %v", err1, err2)
	}
	if !w1 || w2 {
		t.Fatalf("claims = %v/%v, want true/false", w1, w2)
	}
	m := model.EmailMessage{}
	db.DB.Where("email_id = ?", id).First(&m)
	if m.Status != repo.StatusSending {
		t.Fatalf("status = %q, want sending", m.Status)
	}
}

func TestEmailWorkerDoubleInstanceNoDoubleSend(t *testing.T) {
	setupTestDB(t)
	sender := &stubSender{}
	cfg := emailCfg()
	cfg.Email.APIKey = "test-key" // bypass the dry-run branch
	svc1 := NewEmailService(cfg)
	svc1.client = sender
	svc2 := NewEmailService(cfg)
	svc2.client = sender

	// 8 封邮件，两个 worker 同时扫同一队列
	var ids []string
	for i := 0; i < 8; i++ {
		id, _ := svc1.Enqueue([]string{"a@x.com"}, nil, "S", "<p>hi</p>", "")
		ids = append(ids, id)
	}
	var both sync.WaitGroup
	both.Add(2)
	go func() { defer both.Done(); svc1.processBatch() }()
	go func() { defer both.Done(); svc2.processBatch() }()
	both.Wait()

	if sender.calls != 8 {
		t.Fatalf("send calls = %d, want exactly 8 (one per email)", sender.calls)
	}
	for _, id := range ids {
		var m model.EmailMessage
		db.DB.Where("email_id = ?", id).First(&m)
		if m.Status != "sent" {
			t.Fatalf("email %s status = %q, want sent", id, m.Status)
		}
	}

	// 稳态：再跑一轮不得重复发送（已 sent 的不再被认领）
	svc1.processBatch()
	svc2.processBatch()
	if sender.calls != 8 {
		t.Fatalf("send calls after steady-state batch = %d, want 8", sender.calls)
	}
}

func TestEmailReclaimStaleSending(t *testing.T) {
	setupTestDB(t)
	sender := &stubSender{}
	cfg := emailCfg()
	cfg.Email.APIKey = "test-key"
	svc := NewEmailService(cfg)
	svc.client = sender
	id, _ := svc.Enqueue([]string{"a@x.com"}, nil, "S", "<p>hi</p>", "")

	// 模拟：实例认领后在发送途中崩溃（claim 时间回拨到 TTL 之外）
	if _, ok, _ := repo.ClaimEmail(id, time.Now().UTC()); !ok {
		t.Fatal("claim failed")
	}
	db.DB.Model(&model.EmailMessage{}).Where("email_id = ?", id).
		Update("updated_at", time.Now().UTC().Add(-5*time.Minute))

	svc.processBatch() // 回收 → 重新认领 → 发送

	if sender.calls != 1 {
		t.Fatalf("send calls = %d, want 1 (reclaimed + redelivered)", sender.calls)
	}
	var m model.EmailMessage
	db.DB.Where("email_id = ?", id).First(&m)
	if m.Status != "sent" {
		t.Fatalf("status = %q, want sent", m.Status)
	}
}

// ── 邮件 fencing：陈旧持有者的发送结果不能覆盖新认领 ─────────────────

func TestEmailMarkFenced(t *testing.T) {
	setupTestDB(t)
	svc := NewEmailService(emailCfg())
	id, _ := svc.Enqueue([]string{"a@x.com"}, nil, "S", "<p>hi</p>", "")

	tok1, w1, _ := repo.ClaimEmail(id, time.Now().UTC())
	if n, err := repo.ReclaimStaleSending(time.Now().UTC().Add(time.Minute)); err != nil || n != 1 {
		t.Fatalf("reclaim = %d %v, want 1 (TTL expired)", n, err)
	}
	tok2, w2, _ := repo.ClaimEmail(id, time.Now().UTC().Add(time.Second))
	if !w1 || !w2 {
		t.Fatalf("claims = %v/%v", w1, w2)
	}

	// 旧持有者的 sent 必须被拒
	if err := repo.MarkEmailSent(id, tok1); err != nil {
		t.Fatalf("stale mark must be a no-op, got err %v", err)
	}
	m := model.EmailMessage{}
	db.DB.Where("email_id = ?", id).First(&m)
	if m.Status != repo.StatusSending {
		t.Fatalf("status = %q after stale mark, want still sending", m.Status)
	}
	// 当前持有者正常标记
	if err := repo.MarkEmailSent(id, tok2); err != nil {
		t.Fatal(err)
	}
	db.DB.Where("email_id = ?", id).First(&m)
	if m.Status != "sent" {
		t.Fatalf("status = %q, want sent", m.Status)
	}
}
