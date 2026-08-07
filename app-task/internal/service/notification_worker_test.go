package service

import (
	"errors"
	"fmt"
	"testing"

	"app-task/internal/config"
	"app-task/internal/db"
	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/resend/resend-go/v2"
)

type mockEmailSender struct {
	err error
}

func (m *mockEmailSender) Send(req *resend.SendEmailRequest) (any, error) {
	return nil, m.err
}

var notifSeq int

func createPendingNotification(t *testing.T, retryCount int) *model.TaskQuizNotification {
	t.Helper()
	notifSeq++
	id := fmt.Sprintf("%s-%d", t.Name(), notifSeq)
	n := &model.TaskQuizNotification{
		NotificationID: "n-" + id,
		TaskID:         "t-" + id,
		Type:           "quiz_email",
		Recipient:      "u@x.com",
		Subject:        "subj",
		BodyHTML:       "<p>body</p>",
		Status:         "pending",
		RetryCount:     retryCount,
	}
	if err := repo.CreateNotification(n); err != nil {
		t.Fatalf("CreateNotification: %v", err)
	}
	return n
}

func notificationStatus(t *testing.T, id string) (status string, retry int) {
	t.Helper()
	var n model.TaskQuizNotification
	if err := db.DB.Where("notification_id = ?", id).First(&n).Error; err != nil {
		t.Fatalf("query notification: %v", err)
	}
	return n.Status, n.RetryCount
}

func TestSendOne_DryRun(t *testing.T) {
	setupTestDB(t)
	n := createPendingNotification(t, 0)

	w := &NotificationWorker{
		cfg:      &config.Config{Email: config.EmailConfig{APIKey: ""}}, // no key -> dry-run
		retryMax: 5,
	}
	w.sendOne(*n)

	if s, _ := notificationStatus(t, n.NotificationID); s != "dry_run" {
		t.Errorf("status = %q, want dry_run (no API key, NOT sent)", s)
	}
}

func TestSendOne_Success(t *testing.T) {
	setupTestDB(t)
	n := createPendingNotification(t, 0)

	w := &NotificationWorker{
		cfg:      &config.Config{Email: config.EmailConfig{APIKey: "key", From: "x@y.com"}},
		retryMax: 5,
		client:   &mockEmailSender{err: nil},
	}
	w.sendOne(*n)

	if s, _ := notificationStatus(t, n.NotificationID); s != "sent" {
		t.Errorf("status = %q, want sent", s)
	}
}

func TestSendOne_Retry(t *testing.T) {
	setupTestDB(t)
	n := createPendingNotification(t, 0) // retry 0 -> 1, not final (< 5)

	w := &NotificationWorker{
		cfg:      &config.Config{Email: config.EmailConfig{APIKey: "key", From: "x@y.com"}},
		retryMax: 5,
		client:   &mockEmailSender{err: errors.New("resend 500")},
	}
	w.sendOne(*n)

	s, retry := notificationStatus(t, n.NotificationID)
	if s != "pending" {
		t.Errorf("status = %q, want pending (retrying)", s)
	}
	if retry != 1 {
		t.Errorf("retry_count = %d, want 1", retry)
	}
}

func TestSendOne_FinalFailure(t *testing.T) {
	setupTestDB(t)
	n := createPendingNotification(t, 4) // retry 4+1=5 >= max 5 -> final

	w := &NotificationWorker{
		cfg:      &config.Config{Email: config.EmailConfig{APIKey: "key", From: "x@y.com"}},
		retryMax: 5,
		client:   &mockEmailSender{err: errors.New("resend 500")},
	}
	w.sendOne(*n)

	if s, _ := notificationStatus(t, n.NotificationID); s != "failed" {
		t.Errorf("status = %q, want failed (max retries reached)", s)
	}
}

func TestProcessBatch_DryRunAll(t *testing.T) {
	setupTestDB(t)
	createPendingNotification(t, 0)
	createPendingNotification(t, 0)

	w := &NotificationWorker{
		cfg:      &config.Config{Email: config.EmailConfig{APIKey: ""}}, // dry-run
		retryMax: 5,
	}
	w.processBatch()

	pending, _ := repo.ListPendingNotifications(50)
	if len(pending) != 0 {
		t.Errorf("pending = %d, want 0 (all dry-run, out of pending queue)", len(pending))
	}
	// all notifications should be marked dry_run (NOT sent)
	var notifs []model.TaskQuizNotification
	db.DB.Find(&notifs)
	if len(notifs) != 2 {
		t.Fatalf("notifications = %d, want 2", len(notifs))
	}
	for _, n := range notifs {
		if n.Status != "dry_run" {
			t.Errorf("status = %q, want dry_run", n.Status)
		}
	}
}
