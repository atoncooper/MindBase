package service

import (
	"log/slog"
	"time"

	"app-task/internal/config"
	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/resend/resend-go/v2"
)

// EmailSender abstracts the Resend send call so tests can stub it without
// hitting the real Resend API. Returns any (the *resend.Email response) since
// callers ignore it; using a concrete type couples to a version-specific name.
type EmailSender interface {
	Send(req *resend.SendEmailRequest) (any, error)
}

// resendClient wraps *resend.Client to satisfy EmailSender.
type resendClient struct{ c *resend.Client }

func (r *resendClient) Send(req *resend.SendEmailRequest) (any, error) {
	return r.c.Emails.Send(req)
}

// NotificationWorker scans pending notifications, sends via Resend, retries on
// failure (max N, exponential backoff). Crash-safe: pending rows persist in
// MySQL and are recovered on restart. If no API key, dry-run marks as sent.
type NotificationWorker struct {
	cfg         *config.Config
	interval    time.Duration
	retryMax    int
	backoffBase int
	client      EmailSender
	stopCh      chan struct{}
}

func NewNotificationWorker(cfg *config.Config) *NotificationWorker {
	var client EmailSender
	if cfg.Email.APIKey != "" {
		client = &resendClient{c: resend.NewClient(cfg.Email.APIKey)}
	}
	return &NotificationWorker{
		cfg:         cfg,
		interval:    time.Duration(cfg.Notification.WorkerIntervalSeconds) * time.Second,
		retryMax:    cfg.Notification.RetryMax,
		backoffBase: cfg.Notification.RetryBackoffBase,
		client:      client,
		stopCh:      make(chan struct{}),
	}
}

func (w *NotificationWorker) Start() {
	go w.loop()
	slog.Info("[NOTIFICATION_WORKER] started", "interval", w.interval)
}

func (w *NotificationWorker) Stop() {
	select {
	case <-w.stopCh:
	default:
		close(w.stopCh)
	}
	slog.Info("[NOTIFICATION_WORKER] stopped")
}

func (w *NotificationWorker) loop() {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-w.stopCh:
			return
		case <-ticker.C:
			w.processBatch()
		}
	}
}

func (w *NotificationWorker) processBatch() {
	pending, err := repo.ListPendingNotifications(50)
	if err != nil {
		slog.Error("[NOTIFICATION_WORKER] list pending failed", "err", err)
		return
	}
	for i := range pending {
		w.sendOne(pending[i])
	}
}

func (w *NotificationWorker) sendOne(n model.TaskQuizNotification) {
	if w.cfg.Email.APIKey == "" {
		// Dry-run: no Resend key configured. Mark as dry_run (NOT sent) so the
		// status is distinguishable from a real send. Pending query skips it.
		slog.Error("[NOTIFICATION_WORKER] no EMAIL_API_KEY; dry-run (email NOT sent)", "id", n.NotificationID, "recipient", n.Recipient)
		_ = repo.MarkNotificationDryRun(n.NotificationID, "dry-run: EMAIL_API_KEY not set")
		return
	}

	to := append([]string{n.Recipient}, toStringSliceJSON(n.CCEmails)...)
	resp, err := w.client.Send(&resend.SendEmailRequest{
		From:    w.cfg.Email.From,
		To:      to,
		Subject: n.Subject,
		Html:    n.BodyHTML,
	})
	if err != nil {
		retry := n.RetryCount + 1
		final := retry >= w.retryMax
		_ = repo.MarkNotificationFailed(n.NotificationID, err.Error(), retry, final)
		if final {
			slog.Error("[NOTIFICATION_WORKER] FAILED after retries", "id", n.NotificationID, "retry", retry, "err", err)
		} else {
			slog.Warn("[NOTIFICATION_WORKER] retry", "id", n.NotificationID, "retry", retry, "max", w.retryMax, "err", err)
		}
		return
	}
	_ = repo.MarkNotificationSent(n.NotificationID)
	resendID := ""
	if email, ok := resp.(*resend.Email); ok && email != nil {
		resendID = email.Id
	}
	slog.Info("[NOTIFICATION_WORKER] sent", "id", n.NotificationID, "to", n.Recipient, "resend_id", resendID)
}
