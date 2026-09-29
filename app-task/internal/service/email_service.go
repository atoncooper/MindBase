package service

import (
	"errors"
	"log/slog"
	"math"
	"time"

	"app-task/internal/config"
	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/google/uuid"
	"github.com/resend/resend-go/v2"
)

// EmailSender abstracts the Resend send call so tests can stub it.
type EmailSender interface {
	Send(req *resend.SendEmailRequest) (any, error)
}

type resendClient struct{ c *resend.Client }

func (r *resendClient) Send(req *resend.SendEmailRequest) (any, error) {
	return r.c.Emails.Send(req)
}

// EmailService is app-task's mail delivery service: third-party executors
// post a standardized email (to/cc/subject/html) via /internal/email/send,
// app-task persists it in email_queue and a background worker delivers it
// with retries (crash-safe, at-least-once). Delivery is a platform
// capability, not business: the scheduler only knows the mail format.
type EmailService struct {
	cfg    *config.Config
	client EmailSender
	stopCh chan struct{}
}

func NewEmailService(cfg *config.Config) *EmailService {
	var client EmailSender
	if cfg.Email.APIKey != "" {
		client = &resendClient{c: resend.NewClient(cfg.Email.APIKey)}
	}
	return &EmailService{cfg: cfg, client: client, stopCh: make(chan struct{})}
}

// Enqueue accepts a standardized email and persists it for delivery.
func (s *EmailService) Enqueue(to, cc []string, subject, html, referenceID string) (string, error) {
	if len(to) == 0 {
		return "", errors.New("to is required")
	}
	if subject == "" || html == "" {
		return "", errors.New("subject and html are required")
	}
	emailID := uuid.NewString()
	m := &model.EmailMessage{
		EmailID:     emailID,
		To:          toJSON(to),
		CC:          toJSON(cc),
		Subject:     subject,
		BodyHTML:    html,
		ReferenceID: referenceID,
		Status:      "pending",
	}
	if err := repo.CreateEmail(m); err != nil {
		return "", err
	}
	slog.Info("[EMAIL] queued", "email_id", emailID, "to", to, "reference", referenceID)
	return emailID, nil
}

// Start launches the delivery worker.
func (s *EmailService) Start() {
	go s.loop()
	slog.Info("[EMAIL_WORKER] started", "interval", s.cfg.Notification.WorkerIntervalSeconds, "retry_max", s.cfg.Notification.RetryMax)
}

// Stop terminates the delivery worker.
func (s *EmailService) Stop() {
	select {
	case <-s.stopCh:
	default:
		close(s.stopCh)
	}
	slog.Info("[EMAIL_WORKER] stopped")
}

func (s *EmailService) loop() {
	// Fire once immediately (crash recovery), then on each tick.
	s.processBatch()
	ticker := time.NewTicker(time.Duration(s.cfg.Notification.WorkerIntervalSeconds) * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			s.processBatch()
		}
	}
}

// emailSendingTTL bounds one delivery attempt; claims older than this are
// reclaimed (must exceed the Resend HTTP timeout).
const emailSendingTTL = 2 * time.Minute

func (s *EmailService) processBatch() {
	// Cluster safety: reclaim emails stuck in sending (crashed worker/instance)
	// before picking up new work — same pattern as the task scheduler.
	if n, err := repo.ReclaimStaleSending(time.Now().UTC().Add(-emailSendingTTL)); err != nil {
		slog.Error("[EMAIL_WORKER] reclaim stale sending failed", "err", err)
	} else if n > 0 {
		slog.Warn("[EMAIL_WORKER] reclaimed stale sending claims", "count", n)
	}
	pending, err := repo.ListDueEmails(50)
	if err != nil {
		slog.Error("[EMAIL_WORKER] list due failed", "err", err)
		return
	}
	for i := range pending {
		// Claim before sending: conditional update pending -> sending, so a
		// second instance scanning the same queue skips already-claimed rows.
		token, ok, err := repo.ClaimEmail(pending[i].EmailID, time.Now().UTC())
		if err != nil {
			slog.Error("[EMAIL_WORKER] claim failed", "email_id", pending[i].EmailID, "err", err)
			continue
		}
		if !ok {
			continue // claimed by another worker/instance
		}
		pending[i].ClaimToken = token
		s.sendOne(&pending[i], token)
	}
}

func (s *EmailService) sendOne(m *model.EmailMessage, claimToken string) {
	if s.cfg.Email.APIKey == "" {
		// Dry-run: no API key configured — mark dry_run (NOT sent), distinct
		// from a real send so delivery status stays honest.
		slog.Error("[EMAIL_WORKER] no EMAIL_API_KEY; dry-run (email NOT sent)", "email_id", m.EmailID)
		_ = repo.MarkEmailDryRun(m.EmailID, claimToken, "dry-run: EMAIL_API_KEY not set")
		return
	}
	to := toStringSliceJSON(m.To)
	cc := toStringSliceJSON(m.CC)
	_, err := s.client.Send(&resend.SendEmailRequest{
		From:    s.cfg.Email.From,
		To:      append(to, cc...),
		Subject: m.Subject,
		Html:    m.BodyHTML,
	})
	if err != nil {
		retry := m.RetryCount + 1
		final := retry >= s.cfg.Notification.RetryMax
		var next *time.Time
		if !final {
			backoff := time.Duration(math.Pow(float64(s.cfg.Notification.RetryBackoffBase), float64(retry))) * time.Second
			if backoff > 5*time.Minute {
				backoff = 5 * time.Minute
			}
			t := time.Now().UTC().Add(backoff)
			next = &t
		}
		_ = repo.MarkEmailFailed(m.EmailID, claimToken, err.Error(), retry, next, final)
		if final {
			slog.Error("[EMAIL_WORKER] FAILED after retries", "email_id", m.EmailID, "retry", retry, "err", err)
		} else {
			slog.Warn("[EMAIL_WORKER] retry", "email_id", m.EmailID, "retry", retry, "max", s.cfg.Notification.RetryMax, "err", err)
		}
		return
	}
	_ = repo.MarkEmailSent(m.EmailID, claimToken)
	slog.Info("[EMAIL_WORKER] sent", "email_id", m.EmailID, "to", to)
}
