// Package service — quiz storage business logic, ported from
// app/services/quiz_share_service.py, quiz_delete.py, quiz_lifecycle.py and
// the read slices of app/repository/quiz_repository.py.
//
// The AI-bearing flows (generate / generate-from-summary / submit+grade)
// stay in the Python backend; this service owns the pure storage face.
package service

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"app-quiz/internal/repo"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"gorm.io/gorm"
)

// GenerationTimeoutMinutes: a quiz still in "generating" after this many
// minutes is considered stuck (parity with quiz_lifecycle).
const GenerationTimeoutMinutes = 10

// Service errors carry an HTTP status + detail (parity with the Python
// HTTPException contract).
type APIError struct {
	Status int
	Detail string
}

func (e *APIError) Error() string { return e.Detail }

func apiErr(status int, detail string) *APIError {
	return &APIError{Status: status, Detail: detail}
}

var (
	// ErrLost is raised after a quiz was marked data-lost; the router maps
	// it to 410 (parity with the Python get_quiz flow).
	ErrLost = errors.New("quiz data lost")
)

// Store wires the data sources into the quiz service.
type Store struct {
	DB     *gorm.DB
	Mongo  *mongo.Database
	Shares ShareCache
	Clock  func() time.Time // UTC clock, overridable in tests

	// Quota is the Redis-backed daily counter (nil = quota disabled, fail-open);
	// QuotaLimits overrides the per-kind daily limits (config quota.*).
	Quota       QuotaCache
	QuotaLimits map[string]int
}

// ShareCache is the Redis L2 cache for public share payloads.
type ShareCache interface {
	GetShareCached(ctx context.Context, token string) (json.RawMessage, bool)
	SetShareCached(ctx context.Context, token string, payload json.RawMessage)
	EvictShare(ctx context.Context, token string)
}

// New builds the service.
func New(db *gorm.DB, mdb *mongo.Database, shares ShareCache) *Store {
	return &Store{DB: db, Mongo: mdb, Shares: shares, Clock: func() time.Time { return time.Now().UTC() }}
}

// ── datetime wire helpers (parity with the Python serialization) ────

// pyStr renders a datetime the way Python's str(datetime) does —
// "2006-01-02 15:04:05" (space separator); nil renders as "".
func pyStr(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.Format("2006-01-02 15:04:05")
}

// pyISO renders a datetime the way Python's datetime.isoformat() does —
// "2006-01-02T15:04:05" (naive UTC, no zone suffix); nil renders as null.
func pyISO(t *time.Time) interface{} {
	if t == nil {
		return nil
	}
	return t.Format("2006-01-02T15:04:05")
}

// parseJSONField decodes a raw JSON column value, falling back to the raw
// string on invalid JSON (parity with the Python _parse_json_field).
func parseJSONField(raw json.RawMessage) interface{} {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var v interface{}
	if err := json.Unmarshal(raw, &v); err != nil {
		return string(raw)
	}
	return v
}

// ── lifecycle ────────────────────────────────────────────────────────

// refreshStaleQuizStates marks the user's stuck generating quizzes as failed
// and sweeps done-but-Mongo-empty quizzes to failed. Best-effort: Mongo
// unavailability skips the empty-check (parity with quiz_lifecycle).
func (s *Store) refreshStaleQuizStates(ctx context.Context, uid int64) {
	cutoff := s.Clock().Add(-GenerationTimeoutMinutes * time.Minute)
	if _, err := repo.MarkGeneratingTimedOut(s.DB, uid, cutoff); err != nil {
		slog.Warn("[QUIZ_LIFECYCLE] timeout sweep failed", "uid", uid, "err", err)
	}
	uuids, err := repo.ListDoneQuizUUIDs(s.DB, uid)
	if err != nil {
		slog.Warn("[QUIZ_LIFECYCLE] done-list failed", "uid", uid, "err", err)
		return
	}
	for _, qid := range uuids {
		if n := repo.CountQuestions(ctx, s.Mongo, qid); n == 0 {
			// Mongo disabled returns -1 (skip); a true zero means data lost.
			if err := repo.MarkQuizLost(s.DB, qid); err != nil {
				slog.Warn("[QUIZ_LIFECYCLE] mark lost failed", "quiz_uuid", qid, "err", err)
			}
		}
	}
}

// refreshOnRead flips a single generating quiz past the timeout to failed
// (parity with quiz_lifecycle.refresh_on_read).
func (s *Store) refreshOnRead(quizUUID string, uid int64) {
	cutoff := s.Clock().Add(-GenerationTimeoutMinutes * time.Minute)
	if err := repo.MarkQuizTimedOut(s.DB, quizUUID, uid, cutoff); err != nil {
		slog.Warn("[QUIZ_LIFECYCLE] single-quiz timeout failed", "quiz_uuid", quizUUID, "err", err)
	}
}

// ── history ──────────────────────────────────────────────────────────

// History returns the user's paginated quiz history.
func (s *Store) History(ctx context.Context, uid int64, page, pageSize int) (map[string]interface{}, error) {
	s.refreshStaleQuizStates(ctx, uid)

	total, err := repo.CountHistory(s.DB, uid)
	if err != nil {
		return nil, err
	}
	rows, err := repo.ListHistory(s.DB, uid, page, pageSize)
	if err != nil {
		return nil, err
	}
	submissions := make([]map[string]interface{}, 0, len(rows))
	for _, r := range rows {
		submissions = append(submissions, map[string]interface{}{
			"submission_uuid":      r.SubmissionUUID,
			"quiz_uuid":            r.QuizUUID,
			"title":                r.Title,
			"status":               r.Status,
			"error_message":        r.ErrorMessage,
			"question_count":       r.QuestionCount,
			"difficulty":           r.Difficulty,
			"source_type":          r.SourceType,
			"score":                r.TotalScore,
			"passed":               r.IsPassed,
			"correct_count":        r.CorrectCount,
			"total_question_count": r.TotalQuestionCount,
			"time_spent_seconds":   r.TimeSpentSeconds,
			"submitted_at":         pyISO(r.SubmittedAt),
			"created_at":           pyStr(r.CreatedAt),
		})
	}
	offset := (page - 1) * pageSize
	return map[string]interface{}{
		"submissions": submissions,
		"total":       total,
		"page":        page,
		"page_size":   pageSize,
		"has_more":    offset+pageSize < total,
	}, nil
}

// ── wrong-answer notebook ────────────────────────────────────────────

// WrongAnswers returns the user's wrong-answer notebook entries.
func (s *Store) WrongAnswers(uid int64, folderIDs []int) (map[string]interface{}, error) {
	rows, err := repo.ListWrongAnswers(s.DB, uid, folderIDs)
	if err != nil {
		return nil, err
	}
	items := make([]map[string]interface{}, 0, len(rows))
	for _, r := range rows {
		items = append(items, map[string]interface{}{
			"question_uuid":   r.QuestionUUID,
			"quiz_uuid":       r.QuizUUID,
			"question_type":   r.QuestionType,
			"difficulty":      r.Difficulty,
			"question_text":   r.QuestionText,
			"options":         parseJSONField(r.Options),
			"user_answer":     parseJSONField(r.UserAnswer),
			"correct_answer":  parseJSONField(r.CorrectAnswerSnapshot),
			"explanation":     r.Explanation,
			"times_wrong":     r.TimesWrong,
			"last_attempt_at": pyISO(r.LastAttemptAt),
		})
	}
	return map[string]interface{}{"wrong_answers": items, "total": len(items)}, nil
}

// ── quiz detail ──────────────────────────────────────────────────────

// GetQuiz returns the quiz set (with or without answers). 404 when missing,
// not owned or deleting; 410 after the data-lost mark.
func (s *Store) GetQuiz(ctx context.Context, uid int64, quizUUID string, includeAnswers bool) (map[string]interface{}, error) {
	s.refreshOnRead(quizUUID, uid)

	qs, err := repo.GetOwnedQuizSet(s.DB, quizUUID, uid)
	if err != nil {
		return nil, err
	}
	if qs == nil || deref(qs.Status) == "deleting" {
		return nil, apiErr(404, "题目集不存在")
	}

	var questions []repo.QuestionDoc
	if includeAnswers {
		questions = repo.GetQuestionsFull(ctx, s.Mongo, quizUUID)
	} else {
		questions = repo.GetQuestions(ctx, s.Mongo, quizUUID)
	}

	// Only flag as lost when the quiz is done but MongoDB is empty —
	// "generating" means the background LLM task hasn't finished yet.
	if (deref(qs.Status) == "done" || deref(qs.Status) == "partial") &&
		derefInt(qs.QuestionCount) > 0 && len(questions) == 0 {
		slog.Warn("[QUIZ] data lost — marking quiz failed",
			"quiz_uuid", quizUUID, "status", deref(qs.Status),
			"question_count", derefInt(qs.QuestionCount))
		if err := repo.MarkQuizLost(s.DB, quizUUID); err != nil {
			slog.Warn("[QUIZ] mark lost failed", "quiz_uuid", quizUUID, "err", err)
		}
		return nil, apiErr(410, "题目数据已丢失，请重新生成")
	}

	sourceType := deref(qs.SourceType)
	if sourceType == "" {
		sourceType = "folder"
	}

	items := make([]map[string]interface{}, 0, len(questions))
	for _, q := range questions {
		item := map[string]interface{}{
			"question_uuid": q["question_uuid"],
			"question_type": q["question_type"],
			"difficulty":    q["difficulty"],
			"question_text": q["question_text"],
			"options":       q["options"],
		}
		if includeAnswers {
			item["correct_answer"] = q["correct_answer"]
			item["explanation"] = q["explanation"]
			item["keywords"] = q["keywords"]
		}
		items = append(items, item)
	}

	status := deref(qs.Status)
	return map[string]interface{}{
		"quiz_uuid":         qs.QuizUUID,
		"title":             qs.Title,
		"status":            status,
		"partial":           status == "partial",
		"error_message":     qs.ErrorMessage,
		"question_count":    qs.QuestionCount,
		"type_distribution": qs.TypeDistribution,
		"difficulty":        qs.Difficulty,
		"total_score":       qs.TotalScore,
		"passing_score":     qs.PassingScore,
		"source_type":       sourceType,
		"source_pages":      parseJSONField(qs.SourcePages),
		"created_at":        pyStr(qs.CreatedAt),
		"questions":         items,
	}, nil
}

// ── delete ───────────────────────────────────────────────────────────

// DeleteQuiz hard-deletes a quiz from Mongo + MySQL. Port of
// quiz_delete.QuizDeleteService.delete_quiz including the two-phase status
// guards and failure recovery.
func (s *Store) DeleteQuiz(ctx context.Context, uid int64, quizUUID string) (map[string]interface{}, error) {
	qs, err := repo.GetOwnedQuizSet(s.DB, quizUUID, uid)
	if err != nil {
		return nil, err
	}
	if qs == nil {
		return nil, apiErr(404, "题目集不存在")
	}
	if deref(qs.Status) == "generating" {
		return nil, apiErr(409, "题目正在生成中，暂不能删除，请稍后再试")
	}

	previousStatus := deref(qs.Status)
	if err := repo.SetStatus(s.DB, quizUUID, uid, "deleting"); err != nil {
		return nil, err
	}

	deletedQuestions, err := repo.DeleteByQuiz(ctx, s.Mongo, quizUUID, uid, true)
	if err != nil {
		if rerr := repo.SetStatus(s.DB, quizUUID, uid, previousStatus); rerr != nil {
			slog.Error("[QUIZ] failed to restore status", "quiz_uuid", quizUUID, "err", rerr)
		}
		slog.Error("[QUIZ] failed to delete Mongo questions", "quiz_uuid", quizUUID, "uid", uid, "err", err)
		return nil, apiErr(503, "题目数据删除失败，请稍后重试")
	}

	deletedAnswers, deletedSubmissions, err := repo.DeleteQuizRecords(s.DB, quizUUID, uid)
	if err != nil {
		// The transaction rolled back; surface the half-deleted state on the
		// row so the user can retry (parity with _mark_delete_failed).
		if rerr := repo.SetStatusWithError(s.DB, quizUUID, uid, "删除未完成，请重试删除"); rerr != nil {
			slog.Error("[QUIZ] failed to mark delete-failed", "quiz_uuid", quizUUID, "err", rerr)
		}
		slog.Error("[QUIZ] failed to delete SQL rows", "quiz_uuid", quizUUID, "uid", uid, "err", err)
		return nil, apiErr(503, "题目记录删除失败，请稍后重试")
	}

	slog.Info("[QUIZ] hard deleted", "quiz_uuid", quizUUID, "uid", uid,
		"questions", deletedQuestions, "submissions", deletedSubmissions, "answers", deletedAnswers)
	return map[string]interface{}{
		"deleted":             true,
		"quiz_uuid":           quizUUID,
		"deleted_questions":   deletedQuestions,
		"deleted_submissions": deletedSubmissions,
		"deleted_answers":     deletedAnswers,
	}, nil
}

// ── sharing ──────────────────────────────────────────────────────────

// generateShareToken returns a URL-safe random token (~122 bits), byte-for-
// byte compatible with Python's secrets.token_urlsafe(16).
func generateShareToken() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func isShareExpired(expiresAt *time.Time, now time.Time) bool {
	return expiresAt != nil && expiresAt.Before(now)
}

// CreateShare issues or rotates the share token for an owned quiz.
func (s *Store) CreateShare(ctx context.Context, quizUUID string, uid int64, expiresAt *time.Time) (map[string]interface{}, error) {
	qs, err := repo.GetOwnedQuizSet(s.DB, quizUUID, uid)
	if err != nil {
		return nil, err
	}
	if qs == nil {
		return nil, apiErr(404, "题目集不存在")
	}
	if deref(qs.Status) != "done" {
		return nil, apiErr(400, "题目尚未生成完成，无法分享")
	}

	token, err := generateShareToken()
	if err != nil {
		return nil, err
	}
	now := s.Clock()
	ok, previous, err := repo.SetShareToken(s.DB, quizUUID, uid, token, expiresAt)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, apiErr(404, "题目集不存在")
	}

	// The old link stops serving immediately at the L2 layer (nginx/browser
	// TTL still apply).
	s.Shares.EvictShare(ctx, deref(previous))

	slog.Info("[QUIZ_SHARE] created", "quiz_uuid", quizUUID, "uid", uid)
	resp := map[string]interface{}{
		"quiz_uuid":        quizUUID,
		"share_token":      token,
		"shared_at":        pyISO(&now),
		"share_expires_at": pyISO(expiresAt),
	}
	return resp, nil
}

// RevokeShare revokes sharing for an owned quiz. Idempotent.
func (s *Store) RevokeShare(ctx context.Context, quizUUID string, uid int64) (map[string]interface{}, error) {
	ok, previous, err := repo.ClearShareToken(s.DB, quizUUID, uid)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, apiErr(404, "题目集不存在")
	}
	s.Shares.EvictShare(ctx, deref(previous))
	slog.Info("[QUIZ_SHARE] revoked", "quiz_uuid", quizUUID, "uid", uid)
	return map[string]interface{}{"quiz_uuid": quizUUID, "shared": false}, nil
}

// ShareStatus is the owner-side share-state query.
func (s *Store) ShareStatus(quizUUID string, uid int64) (map[string]interface{}, error) {
	qs, err := repo.GetOwnedQuizSet(s.DB, quizUUID, uid)
	if err != nil {
		return nil, err
	}
	if qs == nil {
		return nil, apiErr(404, "题目集不存在")
	}
	if deref(qs.ShareToken) == "" {
		return map[string]interface{}{"quiz_uuid": quizUUID, "shared": false}, nil
	}
	return map[string]interface{}{
		"quiz_uuid":        quizUUID,
		"shared":           true,
		"share_token":      qs.ShareToken,
		"shared_at":        pyISO(qs.SharedAt),
		"share_expires_at": pyISO(qs.ShareExpiresAt),
		"expired":          isShareExpired(qs.ShareExpiresAt, s.Clock()),
	}, nil
}

// GetSharedQuiz is the public read: shared quiz WITHOUT answers, backed by
// the Redis L2 cache (60s TTL, fail-open).
func (s *Store) GetSharedQuiz(ctx context.Context, shareToken string) (json.RawMessage, error) {
	if payload, ok := s.Shares.GetShareCached(ctx, shareToken); ok {
		return payload, nil
	}

	payload, err := s.buildSharedQuizPayload(ctx, shareToken)
	if err != nil {
		return nil, err
	}
	s.Shares.SetShareCached(ctx, shareToken, payload)
	return payload, nil
}

func (s *Store) buildSharedQuizPayload(ctx context.Context, shareToken string) (json.RawMessage, error) {
	notFound := apiErr(404, "分享链接无效或已失效")

	qs, err := repo.GetQuizSetByShareToken(s.DB, shareToken)
	if err != nil {
		return nil, err
	}
	if qs == nil || deref(qs.Status) != "done" || isShareExpired(qs.ShareExpiresAt, s.Clock()) {
		return nil, notFound
	}

	// Questions only — no answers/explanations/keywords on the public path.
	questions := repo.GetQuestions(ctx, s.Mongo, qs.QuizUUID)
	if len(questions) == 0 {
		slog.Warn("[QUIZ_SHARE] share_token has no questions in MongoDB", "quiz_uuid", qs.QuizUUID)
		return nil, notFound
	}

	sourceType := deref(qs.SourceType)
	if sourceType == "" {
		sourceType = "folder"
	}
	items := make([]map[string]interface{}, 0, len(questions))
	for _, q := range questions {
		items = append(items, map[string]interface{}{
			"question_uuid": q["question_uuid"],
			"question_type": q["question_type"],
			"difficulty":    q["difficulty"],
			"question_text": q["question_text"],
			"options":       q["options"],
		})
	}
	payload := map[string]interface{}{
		"quiz_uuid":         qs.QuizUUID,
		"title":             qs.Title,
		"question_count":    qs.QuestionCount,
		"type_distribution": qs.TypeDistribution,
		"difficulty":        qs.Difficulty,
		"total_score":       qs.TotalScore,
		"passing_score":     qs.PassingScore,
		"source_type":       sourceType,
		"shared_at":         pyISO(qs.SharedAt),
		"share_expires_at":  pyISO(qs.ShareExpiresAt),
		"questions":         items,
	}
	b, err := marshalNoHTMLEscape(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal shared quiz: %w", err)
	}
	return b, nil
}

// ── small helpers ────────────────────────────────────────────────────

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefInt(n *int) int {
	if n == nil {
		return 0
	}
	return *n
}
