// MySQL data access for app-quiz — port of app/repository/quiz_repository.py,
// app/services/quiz_lifecycle.py and app/services/quiz_delete.py (SQL slice).
// All queries are parameterised; no user input is ever string-interpolated
// into SQL text.
package repo

import (
	"encoding/json"
	"strconv"
	"time"

	"gorm.io/gorm"
)

// QuizSetRow mirrors the quiz_sets columns the service layer reads.
type QuizSetRow struct {
	QuizUUID         string          `json:"quiz_uuid"`
	UID              *int64          `json:"uid"`
	Title            string          `json:"title"`
	QuestionCount    *int            `json:"question_count"`
	TypeDistribution json.RawMessage `json:"type_distribution"`
	Difficulty       *string         `json:"difficulty"`
	FolderIDs        json.RawMessage `json:"folder_ids"`
	SourceType       *string         `json:"source_type"`
	SourcePages      json.RawMessage `json:"source_pages"`
	Status           *string         `json:"status"`
	ErrorMessage     *string         `json:"error_message"`
	TotalScore       *int            `json:"total_score"`
	PassingScore     *int            `json:"passing_score"`
	ShareToken       *string         `json:"share_token"`
	SharedAt         *time.Time      `json:"shared_at"`
	ShareExpiresAt   *time.Time      `json:"share_expires_at"`
	CreatedAt        *time.Time      `json:"-"`
}

// HistoryRow is one history list entry (quiz_sets LEFT JOIN quiz_submissions).
type HistoryRow struct {
	QuizUUID           string     `json:"quiz_uuid"`
	Title              string     `json:"title"`
	Status             *string    `json:"status"`
	ErrorMessage       *string    `json:"error_message"`
	QuestionCount      *int       `json:"question_count"`
	Difficulty         *string    `json:"difficulty"`
	SourceType         *string    `json:"source_type"`
	SubmissionUUID     *string    `json:"submission_uuid"`
	TotalScore         *int       `json:"score"`
	IsPassed           *bool      `json:"passed"`
	CorrectCount       *int       `json:"correct_count"`
	TotalQuestionCount *int       `json:"total_question_count"`
	TimeSpentSeconds   *int       `json:"time_spent_seconds"`
	SubmittedAt        *time.Time `json:"submitted_at"`
	CreatedAt          *time.Time `json:"-"`
}

// WrongAnswerRow is one wrong-answer notebook entry.
type WrongAnswerRow struct {
	QuestionUUID          string          `json:"question_uuid"`
	QuizUUID              string          `json:"quiz_uuid"`
	QuestionType          string          `json:"question_type"`
	Difficulty            *string         `json:"difficulty"`
	QuestionText          string          `json:"question_text"`
	Options               json.RawMessage `json:"options"`
	UserAnswer            json.RawMessage `json:"user_answer"`
	CorrectAnswerSnapshot json.RawMessage `json:"correct_answer"`
	Explanation           *string         `json:"explanation"`
	TimesWrong            int             `json:"times_wrong"`
	LastAttemptAt         *time.Time      `json:"last_attempt_at"`
}

// ExportRow is one exportable answer record.
type ExportRow struct {
	QuizUUID              string          `json:"quiz_uuid"`
	FolderIDs             json.RawMessage `json:"folder_ids"`
	QuestionUUID          string          `json:"question_uuid"`
	QuestionType          string          `json:"type"`
	Difficulty            *string         `json:"difficulty"`
	QuestionText          string          `json:"question"`
	Options               json.RawMessage `json:"options"`
	Explanation           *string         `json:"explanation"`
	SourceSegment         *string         `json:"source_segment"`
	Bvid                  *string         `json:"bvid"`
	UserAnswer            json.RawMessage `json:"user_answer"`
	UserAnswerText        *string         `json:"user_answer_text"`
	IsCorrect             *bool           `json:"is_correct"`
	CorrectAnswerSnapshot json.RawMessage `json:"correct_answer"`
	SubmissionUUID        string          `json:"submission_uuid"`
	SubmittedAt           *time.Time      `json:"timestamp"`
}

// CountHistory counts quiz_sets with terminal status for the user.
func CountHistory(db *gorm.DB, uid int64) (int, error) {
	var n int64
	err := db.Raw(
		"SELECT COUNT(*) FROM quiz_sets WHERE uid = ? AND status IN ('done', 'failed')",
		uid,
	).Scan(&n).Error
	return int(n), err
}

// ListHistory returns one paginated history row per quiz_set; submission
// columns are NULL when the user has not submitted yet.
func ListHistory(db *gorm.DB, uid int64, page, pageSize int) ([]HistoryRow, error) {
	offset := (page - 1) * pageSize
	var rows []HistoryRow
	err := db.Raw(
		`SELECT qs.quiz_uuid, qs.title, qs.question_count,
		        qs.difficulty, qs.status, qs.source_type,
		        qs.error_message, qs.created_at,
		        qsub.submission_uuid, qsub.total_score,
		        qsub.is_passed, qsub.correct_count,
		        qsub.total_question_count, qsub.time_spent_seconds,
		        qsub.submitted_at
		 FROM quiz_sets qs
		 LEFT JOIN quiz_submissions qsub
		   ON qsub.quiz_uuid = qs.quiz_uuid AND qsub.uid = ?
		 WHERE qs.uid = ?
		   AND qs.status IN ('done', 'failed', 'generating', 'partial')
		 ORDER BY qs.created_at DESC
		 LIMIT ? OFFSET ?`,
		uid, uid, pageSize, offset,
	).Scan(&rows).Error
	return rows, err
}

// ListWrongAnswers returns the wrong-answer notebook, optionally filtered by
// folder_ids via parameterised LIKE clauses (placeholders are appended from
// validated integers — no injection surface).
func ListWrongAnswers(db *gorm.DB, uid int64, folderIDs []int) ([]WrongAnswerRow, error) {
	sql := `SELECT qq.question_uuid, qq.quiz_uuid, qq.question_type, qq.difficulty,
		       qq.question_text, qq.options,
		       ANY_VALUE(qa.user_answer) as user_answer,
		       ANY_VALUE(qa.correct_answer_snapshot) as correct_answer_snapshot,
		       qq.explanation,
		       COUNT(qa.id) as times_wrong,
		       MAX(qa.submitted_at) as last_attempt_at
		FROM quiz_answers qa
		JOIN quiz_submissions qsub ON qsub.submission_uuid = qa.submission_uuid
		JOIN quiz_questions qq ON qq.question_uuid = qa.question_uuid
		JOIN quiz_sets qs ON qs.quiz_uuid = qsub.quiz_uuid
		WHERE qsub.uid = ? AND qa.is_correct = 0 AND qs.status = 'done'
		GROUP BY qq.question_uuid, qq.question_type, qq.difficulty, qq.question_text, qq.options, qq.explanation`
	args := []interface{}{uid}
	if len(folderIDs) > 0 {
		conds := make([]string, 0, len(folderIDs))
		for _, fid := range folderIDs {
			conds = append(conds, "qs.folder_ids LIKE ?")
			args = append(args, "%"+strconv.Itoa(fid)+"%")
		}
		sql += " AND (" + joinOr(conds) + ")"
	}
	sql += " ORDER BY last_attempt_at DESC"

	var rows []WrongAnswerRow
	err := db.Raw(sql, args...).Scan(&rows).Error
	return rows, err
}

// ListExportRecords returns every exportable answer record for a user,
// newest submission first.
func ListExportRecords(db *gorm.DB, uid int64) ([]ExportRow, error) {
	var rows []ExportRow
	err := db.Raw(
		`SELECT
		    qs.quiz_uuid, qs.folder_ids,
		    qq.question_uuid, qq.question_type, qq.difficulty,
		    qq.question_text, qq.options, qq.explanation,
		    qq.source_segment, qq.bvid,
		    qa.user_answer, qa.user_answer_text, qa.is_correct,
		    qa.correct_answer_snapshot,
		    qsub.submission_uuid, qsub.submitted_at
		 FROM quiz_answers qa
		 JOIN quiz_submissions qsub ON qsub.submission_uuid = qa.submission_uuid
		 JOIN quiz_questions qq ON qq.question_uuid = qa.question_uuid
		 JOIN quiz_sets qs ON qs.quiz_uuid = qsub.quiz_uuid
		 WHERE qsub.uid = ? AND qs.status = 'done'
		 ORDER BY qsub.submitted_at DESC`,
		uid,
	).Scan(&rows).Error
	return rows, err
}

// GetOwnedQuizSet fetches a quiz_set owned by uid (nil when not found or not
// owned — callers treat both as 404 to avoid leaking existence).
func GetOwnedQuizSet(db *gorm.DB, quizUUID string, uid int64) (*QuizSetRow, error) {
	var row QuizSetRow
	err := db.Raw(quizSetColumns+" FROM quiz_sets WHERE quiz_uuid = ? AND uid = ?",
		quizUUID, uid,
	).Scan(&row).Error
	if err != nil {
		return nil, err
	}
	if row.QuizUUID == "" {
		return nil, nil
	}
	return &row, nil
}

// GetQuizSetByShareToken fetches a quiz_set by share_token (public read path,
// no uid scoping).
func GetQuizSetByShareToken(db *gorm.DB, shareToken string) (*QuizSetRow, error) {
	var row QuizSetRow
	err := db.Raw(quizSetColumns+" FROM quiz_sets WHERE share_token = ?",
		shareToken,
	).Scan(&row).Error
	if err != nil {
		return nil, err
	}
	if row.QuizUUID == "" {
		return nil, nil
	}
	return &row, nil
}

const quizSetColumns = "SELECT quiz_uuid, uid, title, question_count, type_distribution, difficulty, " +
	"folder_ids, source_type, source_pages, status, error_message, total_score, " +
	"passing_score, share_token, shared_at, share_expires_at, created_at"

// SetShareToken rotates the share token on an owned quiz and returns the
// previous token (so the caller can evict its cache entry). ok=false when
// the quiz is not found / not owned.
func SetShareToken(db *gorm.DB, quizUUID string, uid int64, token string, expiresAt *time.Time) (bool, *string, error) {
	var prevRow struct{ ShareToken *string }
	if err := db.Raw(
		"SELECT share_token FROM quiz_sets WHERE quiz_uuid = ? AND uid = ?",
		quizUUID, uid,
	).Scan(&prevRow).Error; err != nil {
		return false, nil, err
	}
	prev := prevRow.ShareToken
	res := db.Exec(
		"UPDATE quiz_sets SET share_token = ?, shared_at = ?, share_expires_at = ? "+
			"WHERE quiz_uuid = ? AND uid = ?",
		token, time.Now().UTC(), expiresAt, quizUUID, uid,
	)
	if res.Error != nil {
		return false, nil, res.Error
	}
	if res.RowsAffected == 0 {
		return false, nil, nil
	}
	return true, prev, nil
}

// ClearShareToken revokes sharing on an owned quiz (idempotent) and returns
// the previous token for cache eviction.
func ClearShareToken(db *gorm.DB, quizUUID string, uid int64) (bool, *string, error) {
	var prevRow struct{ ShareToken *string }
	if err := db.Raw(
		"SELECT share_token FROM quiz_sets WHERE quiz_uuid = ? AND uid = ?",
		quizUUID, uid,
	).Scan(&prevRow).Error; err != nil {
		return false, nil, err
	}
	prev := prevRow.ShareToken
	res := db.Exec(
		"UPDATE quiz_sets SET share_token = NULL, shared_at = NULL, share_expires_at = NULL "+
			"WHERE quiz_uuid = ? AND uid = ?",
		quizUUID, uid,
	)
	if res.Error != nil {
		return false, nil, res.Error
	}
	if res.RowsAffected == 0 {
		return false, nil, nil
	}
	return true, prev, nil
}

// StuckGeneratingRow is one 'generating' quiz past the sweep floor. The caller
// decides the terminal status per quiz by counting checkpointed questions
// (partial when any survived, failed when not) and scales the allowed window
// by QuestionCount (allowedFor).
type StuckGeneratingRow struct {
	QuizUUID      string
	QuestionCount int
	CreatedAt     time.Time
}

// ListGeneratingStuck returns the user's 'generating' quizzes whose last DB
// activity (updated_at — bumped by every checkpoint append) is older than the
// FLOOR cutoff. Activity-based, not age-based: a slow-but-alive generation
// that keeps checkpointing is never swept, while a truly stuck one (no
// successful append within the window) is. Rows younger than the base can
// never be timed out — the per-row allowed duration is always >= base.
func ListGeneratingStuck(db *gorm.DB, uid int64, floor time.Time) ([]StuckGeneratingRow, error) {
	var rows []StuckGeneratingRow
	err := db.Raw(
		"SELECT quiz_uuid, question_count, created_at FROM quiz_sets "+
			"WHERE uid = ? AND status = 'generating' AND updated_at < ?",
		uid, floor,
	).Scan(&rows).Error
	return rows, err
}

// QuizSetLiteRow carries the columns the single-quiz timeout sweep needs.
type QuizSetLiteRow struct {
	QuestionCount int
	CreatedAt     time.Time
}

// GetQuizSetLite fetches question_count + created_at for one quiz (uid-guarded).
func GetQuizSetLite(db *gorm.DB, quizUUID string, uid int64) (*QuizSetLiteRow, error) {
	var row QuizSetLiteRow
	err := db.Raw(
		"SELECT question_count, created_at FROM quiz_sets WHERE quiz_uuid = ? AND uid = ?",
		quizUUID, uid,
	).Scan(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// MarkQuizTimedOutStatus flips a single stuck generating quiz to the given
// terminal status (partial when checkpoints survived, failed otherwise).
// Conditional on status='generating' so a concurrently-finalizing quiz never
// gets clobbered. The stale check is activity-based (updated_at < cutoff):
// checkpoint appends bump updated_at, so a live generation is never swept
// mid-run regardless of when it was created (this is what made resumed /
// long-running large papers viable — the old created_at basis killed any
// generation that simply took longer than the window).
func MarkQuizTimedOutStatus(db *gorm.DB, quizUUID string, uid int64, cutoff time.Time, status, message string) error {
	return db.Exec(
		"UPDATE quiz_sets SET status = ?, error_message = ?, updated_at = ? "+
			"WHERE quiz_uuid = ? AND uid = ? AND status = 'generating' AND updated_at < ?",
		status, message, time.Now().UTC(), quizUUID, uid, cutoff,
	).Error
}

// ReopenQuizSet flips an owned partial quiz back to 'generating' so the AI
// orchestrator (app-ts) can checkpoint-append the remaining questions and
// finalize. Conditional on status='partial': done/failed/deleting sets are
// never reopened. Clears the stale sweep message; updated_at bumps forward,
// which also restarts the activity-based sweep window.
func ReopenQuizSet(db *gorm.DB, quizUUID string, uid int64) (bool, error) {
	res := db.Exec(
		"UPDATE quiz_sets SET status = 'generating', error_message = NULL, updated_at = ? "+
			"WHERE quiz_uuid = ? AND uid = ? AND status = 'partial'",
		time.Now().UTC(), quizUUID, uid,
	)
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected > 0, nil
}

// QuizTitleExists reports whether the user already has ANOTHER quiz with the
// same title. Uniqueness is per-uid; MySQL collation makes it case-insensitive.
func QuizTitleExists(db *gorm.DB, uid int64, title string, excludeUUID string) (bool, error) {
	var n int64
	err := db.Raw(
		"SELECT COUNT(*) FROM quiz_sets WHERE uid = ? AND title = ? AND quiz_uuid <> ?",
		uid, title, excludeUUID,
	).Scan(&n).Error
	return n > 0, err
}

// RenameQuizSet updates the title of an owned quiz (any status except
// deleting). RowsAffected == 0 → gorm.ErrRecordNotFound (caller maps to 404).
func RenameQuizSet(db *gorm.DB, quizUUID string, uid int64, title string) error {
	res := db.Exec(
		"UPDATE quiz_sets SET title = ?, updated_at = ? "+
			"WHERE quiz_uuid = ? AND uid = ? AND (status IS NULL OR status <> 'deleting')",
		title, time.Now().UTC(), quizUUID, uid,
	)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// ListDoneQuizUUIDs returns the user's 'done' quiz uuids for the
// done-but-MongoDB-empty stale sweep.
func ListDoneQuizUUIDs(db *gorm.DB, uid int64) ([]string, error) {
	var uuids []string
	err := db.Raw(
		"SELECT quiz_uuid FROM quiz_sets WHERE uid = ? AND status = 'done'", uid,
	).Scan(&uuids).Error
	return uuids, err
}

// MarkQuizLost flips a quiz_set to failed with a data-lost message.
func MarkQuizLost(db *gorm.DB, quizUUID string) error {
	return db.Exec(
		"UPDATE quiz_sets SET status = 'failed', "+
			"error_message = 'MongoDB data lost — questions not found' "+
			"WHERE quiz_uuid = ?",
		quizUUID,
	).Error
}

// DeleteQuizRecords hard-deletes the SQL side of a quiz: answers (via the
// quiz's submissions), submissions, then the quiz_set row. Runs in one
// transaction; the caller owns the pre-marked 'deleting' status and any
// failure recovery.
func DeleteQuizRecords(db *gorm.DB, quizUUID string, uid int64) (answers, submissions int64, err error) {
	err = db.Transaction(func(tx *gorm.DB) error {
		var subUUIDs []string
		if err := tx.Raw(
			"SELECT submission_uuid FROM quiz_submissions WHERE quiz_uuid = ?",
			quizUUID,
		).Scan(&subUUIDs).Error; err != nil {
			return err
		}
		if len(subUUIDs) > 0 {
			res := tx.Exec(
				"DELETE FROM quiz_answers WHERE submission_uuid IN (?)", subUUIDs)
			if res.Error != nil {
				return res.Error
			}
			answers = res.RowsAffected
		}
		res := tx.Exec("DELETE FROM quiz_submissions WHERE quiz_uuid = ?", quizUUID)
		if res.Error != nil {
			return res.Error
		}
		submissions = res.RowsAffected
		res = tx.Exec("DELETE FROM quiz_sets WHERE quiz_uuid = ? AND uid = ?", quizUUID, uid)
		if res.Error != nil {
			return res.Error
		}
		return nil
	})
	return answers, submissions, err
}

// SetStatus moves a quiz_set to an arbitrary status.
func SetStatus(db *gorm.DB, quizUUID string, uid int64, status string) error {
	return db.Exec(
		"UPDATE quiz_sets SET status = ? WHERE quiz_uuid = ? AND uid = ?",
		status, quizUUID, uid,
	).Error
}

// SetStatusWithError moves a quiz_set to failed with a message (used by the
// delete-failure recovery path).
func SetStatusWithError(db *gorm.DB, quizUUID string, uid int64, message string) error {
	return db.Exec(
		"UPDATE quiz_sets SET status = 'failed', error_message = ? "+
			"WHERE quiz_uuid = ? AND uid = ?",
		message, quizUUID, uid,
	).Error
}

func joinOr(conds []string) string {
	out := ""
	for i, c := range conds {
		if i > 0 {
			out += " OR "
		}
		out += c
	}
	return out
}
