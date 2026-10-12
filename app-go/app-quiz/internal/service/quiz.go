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
	"strings"
	"time"

	"app-quiz/internal/repo"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"gorm.io/gorm"
	"golang.org/x/crypto/bcrypt"
)

// GenerationTimeoutBaseMinutes: a quiz still in "generating" past this base
// window is considered stuck (parity with quiz_lifecycle). 实际允许时长按题量
// 缩放：allowedFor(questionCount) = max(base, ceil(count/2) 分钟) —— 大卷（40+
// 题，plan-then-generate 并发批）自动获得更长窗口。即便超时，checkpoint 已增量
// 落库，清扫按已存题数判 partial 而非 failed。基数可经
// APPQUIZ__LIFECYCLE__GENERATION_TIMEOUT_MINUTES 配置（config Validate 默认 15）。
const GenerationTimeoutBaseMinutes = 15

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

	// GenTimeoutBase is the base stuck-generating window (config
	// lifecycle.generation_timeout_minutes). Zero/negative = built-in default;
	// the effective window always scales with question count (allowedFor).
	GenTimeoutBase time.Duration
}

// ShareCache is the Redis L2 cache for public share payloads.
type ShareCache interface {
	GetShareCached(ctx context.Context, token string) (json.RawMessage, bool)
	SetShareCached(ctx context.Context, token string, payload json.RawMessage)
	EvictShare(ctx context.Context, token string)
}

// New builds the service.
func New(db *gorm.DB, mdb *mongo.Database, shares ShareCache) *Store {
	return &Store{
		DB:             db,
		Mongo:          mdb,
		Shares:         shares,
		Clock:          func() time.Time { return time.Now().UTC() },
		GenTimeoutBase: GenerationTimeoutBaseMinutes * time.Minute,
	}
}

// genTimeoutBase returns the configured base window (defensive default for
// zero-value Stores built in tests).
func (s *Store) genTimeoutBase() time.Duration {
	if s.GenTimeoutBase <= 0 {
		return GenerationTimeoutBaseMinutes * time.Minute
	}
	return s.GenTimeoutBase
}

// allowedFor scales the timeout with the question count: 大卷（40-50 题）逐批
// 生成天然更久，题量每 2 题放宽 1 分钟，且不低于配置基数。
func (s *Store) allowedFor(questionCount int) time.Duration {
	base := s.genTimeoutBase()
	scaled := time.Duration((questionCount+1)/2) * time.Minute
	if scaled > base {
		return scaled
	}
	return base
}

// ── datetime wire helpers ────────────────────────────────────────────

// pyStr/pyISO render datetimes as UTC RFC3339 WITH the Z suffix. 历史 Python
// 平价格式（naive "2006-01-02 15:04:05"，无时区后缀）会被浏览器 new Date()
// 按本地时区误读——东八区用户看到的时间比真实早 8 小时（晚 10 点显示成
// 中午/下午）。带 Z 后前端正确转本地时区；倒计时（task deadline）同样修复。
func pyStr(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// pyISO renders a datetime as UTC RFC3339; nil renders as null.
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
	floor := s.Clock().Add(-s.genTimeoutBase())
	stuck, err := repo.ListGeneratingStuck(s.DB, uid, floor)
	if err != nil {
		slog.Warn("[QUIZ_LIFECYCLE] timeout sweep failed", "uid", uid, "err", err)
		return
	}
	for _, row := range stuck {
		allowed := s.allowedFor(row.QuestionCount)
		if s.Clock().Before(row.CreatedAt.Add(allowed)) {
			continue // 按题量缩放后仍在允许窗口内
		}
		// checkpoint 生效：已存题数 > 0 → partial（题目可练），否则 failed
		status, message := statusForTimedGeneration(repo.CountQuestions(ctx, s.Mongo, row.QuizUUID))
		if err := repo.MarkQuizTimedOutStatus(s.DB, row.QuizUUID, uid, s.Clock().Add(-allowed), status, message); err != nil {
			slog.Warn("[QUIZ_LIFECYCLE] timeout mark failed", "quiz_uuid", row.QuizUUID, "err", err)
		}
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

// refreshOnRead flips a single generating quiz past the timeout to its
// terminal state (parity with quiz_lifecycle.refresh_on_read; checkpoint-aware
// —— 已有增量落库题目时判 partial 而非 failed)。UPDATE 对未超时行是 no-op。
func (s *Store) refreshOnRead(quizUUID string, uid int64) {
	row, err := repo.GetQuizSetLite(s.DB, quizUUID, uid)
	if err != nil {
		slog.Warn("[QUIZ_LIFECYCLE] read-row failed", "quiz_uuid", quizUUID, "err", err)
		return
	}
	if row == nil || (row.QuestionCount == 0 && row.CreatedAt.IsZero()) {
		return // 行不存在（gorm Scan 空结果不报错）
	}
	cutoff := s.Clock().Add(-s.allowedFor(row.QuestionCount))
	count := repo.CountQuestions(context.Background(), s.Mongo, quizUUID)
	status, message := statusForTimedGeneration(count)
	if err := repo.MarkQuizTimedOutStatus(s.DB, quizUUID, uid, cutoff, status, message); err != nil {
		slog.Warn("[QUIZ_LIFECYCLE] single-quiz timeout failed", "quiz_uuid", quizUUID, "err", err)
	}
}

// statusForTimedGeneration decides the terminal state of a stuck generating
// quiz by its checkpointed question count: > 0 → partial（已生成题目可练），
// else failed。count < 0 = Mongo 不可用（未知）→ failed（安全默认）。
func statusForTimedGeneration(count int) (status, message string) {
	if count > 0 {
		return "partial", "生成超时中断，已保留已生成的部分题目"
	}
	return "failed", "生成超时"
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
	resp := map[string]interface{}{
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
	}
	// 生成中的执行步骤（app-ts 管线上报）：仅 generating 期返回，终态不再暴露
	if status == "generating" {
		if p := repo.GetGenerationProgress(ctx, s.Mongo, quizUUID); p != nil {
			resp["generation_progress"] = p
		}
	}
	return resp, nil
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
	repo.DeleteGenerationProgress(ctx, s.Mongo, quizUUID)
	repo.DeleteShareSecretByQuiz(ctx, s.Mongo, quizUUID)
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

// RenameQuiz updates the user-facing title of one owned quiz. 标题在同账号内
// 唯一（MySQL collation 大小写不敏感）；空/超长 400，重名 409，非本人/不存在 404。
func (s *Store) RenameQuiz(uid int64, quizUUID string, title string) (map[string]interface{}, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return nil, apiErr(400, "标题不能为空")
	}
	if len([]rune(title)) > 60 {
		return nil, apiErr(400, "标题最长 60 字")
	}
	qs, err := repo.GetOwnedQuizSet(s.DB, quizUUID, uid)
	if err != nil {
		return nil, err
	}
	if qs == nil {
		return nil, apiErr(404, "题目集不存在")
	}
	if deref(qs.Status) == "deleting" {
		return nil, apiErr(409, "题目正在删除中，暂不能重命名")
	}
	exists, err := repo.QuizTitleExists(s.DB, uid, title, quizUUID)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, apiErr(409, "标题已存在，请换一个名字")
	}
	if err := repo.RenameQuizSet(s.DB, quizUUID, uid, title); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apiErr(404, "题目集不存在")
		}
		return nil, err
	}
	slog.Info("[QUIZ] renamed", "quiz_uuid", quizUUID, "uid", uid)
	return map[string]interface{}{"quiz_uuid": quizUUID, "title": title}, nil
}

// UpdateGenerationProgress stores one pipeline step reported by app-ts
// (best-effort channel; failures in app-ts are logged, not fatal).
func (s *Store) UpdateGenerationProgress(ctx context.Context, uid int64, quizUUID, stage, detail string, stored, total int) error {
	if strings.TrimSpace(stage) == "" {
		return apiErr(400, "stage 必填")
	}
	repo.SaveGenerationProgress(ctx, s.Mongo, repo.GenerationProgress{
		QuizUUID: quizUUID,
		UID:      uid,
		Stage:    stage,
		Detail:   strings.TrimSpace(detail),
		Stored:   stored,
		Total:    total,
		UpdatedAt: s.Clock(),
	})
	return nil
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
func (s *Store) CreateShare(ctx context.Context, quizUUID string, uid int64, expiresAt *time.Time, password string) (map[string]interface{}, error) {
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

	// 访问口令（可选）：bcrypt 哈希存 Mongo（quiz_sets 不 ALTER）；留空 = 清除旧口令。
	if pw := strings.TrimSpace(password); pw != "" {
		hash, herr := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.MinCost)
		if herr != nil {
			return nil, apiErr(500, "密码处理失败")
		}
		repo.SaveShareSecret(ctx, s.Mongo, token, quizUUID, uid, string(hash))
	} else {
		repo.DeleteShareSecretByToken(ctx, s.Mongo, token)
	}

	// The old link stops serving immediately at the L2 layer (nginx/browser
	// TTL still apply).
	s.Shares.EvictShare(ctx, deref(previous))

	slog.Info("[QUIZ_SHARE] created", "quiz_uuid", quizUUID, "uid", uid, "password_protected", strings.TrimSpace(password) != "")
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
	repo.DeleteShareSecretByToken(ctx, s.Mongo, deref(previous))
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
		"has_password":     repo.GetShareSecretHash(context.Background(), s.Mongo, deref(qs.ShareToken)) != "",
	}, nil
}

// GetSharedQuiz is the public read: shared quiz WITHOUT answers, backed by
// the Redis L2 cache (60s TTL, fail-open). 带口令的分享先验证密码（先于缓存）。
func (s *Store) GetSharedQuiz(ctx context.Context, shareToken string, password string) (json.RawMessage, error) {
	if hash := repo.GetShareSecretHash(ctx, s.Mongo, shareToken); hash != "" {
		if strings.TrimSpace(password) == "" {
			return nil, apiErr(401, "此分享已设置密码，请输入密码访问")
		}
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
			return nil, apiErr(401, "密码错误，请重试")
		}
	}

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
