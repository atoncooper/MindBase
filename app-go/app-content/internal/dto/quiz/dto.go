// Package quiz defines HTTP request DTOs for the quiz storage domain. The
// service view types remain in service/quiz; this package only owns boundary
// shapes and validation tags so routers stay thin.
package quiz

import (
	"encoding/json"
	"strconv"
	"strings"
)

// AgentQuestion is one question from the quiz agent / AI generation flow.
// It mirrors the service input type; the router maps it at the boundary.
type AgentQuestion struct {
	Question       string          `json:"question"`
	QuestionType   string          `json:"question_type,omitempty"`
	Difficulty     string          `json:"difficulty,omitempty"`
	Score          float64         `json:"score,omitempty"`
	Options        []string        `json:"options,omitempty"`
	Answer         string          `json:"answer,omitempty"`
	CorrectAnswer  json.RawMessage `json:"correct_answer,omitempty"`
	Explanation    string          `json:"explanation"`
	Keywords       []string        `json:"keywords,omitempty"`
	BVID           string          `json:"bvid,omitempty"`
	ChunkID        string          `json:"chunk_id,omitempty"`
	SourceSegment  string          `json:"source_segment,omitempty"`
	AnswerTemplate string          `json:"answer_template,omitempty"`
	ScoringRubric  json.RawMessage `json:"scoring_rubric,omitempty"`
	ModelAnswer    string          `json:"model_answer,omitempty"`
}

// AgentVerdict is one per-question grading verdict.
type AgentVerdict struct {
	Index    int    `json:"index"`
	Verdict  string `json:"verdict"`
	Feedback string `json:"feedback"`
}

// FlexInt64 accepts a JSON number OR a numeric string for int64 uid fields
// (app-ts carries uid as string for JS precision safety); the X-Uid header
// stays authoritative and body uid, when present, must agree with it.
type FlexInt64 int64

// UnmarshalJSON implements the dual number/string contract.
func (f *FlexInt64) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return err
	}
	*f = FlexInt64(v)
	return nil
}

// GradingPayloadRequest is the grading-payload lookup body.
type GradingPayloadRequest struct {
	UID      FlexInt64 `json:"uid"`
	QuizUUID string    `json:"quiz_uuid" binding:"required"`
}

// SubmissionAnswer is one graded answer in a submission.
type SubmissionAnswer struct {
	QuestionUUID          string          `json:"question_uuid" binding:"required"`
	QuestionType          string          `json:"question_type"`
	UserAnswer            json.RawMessage `json:"user_answer"`
	UserAnswerText        *string         `json:"user_answer_text"`
	IsCorrect             *bool           `json:"is_correct"`
	AutoScore             *int            `json:"auto_score"`
	CorrectAnswerSnapshot json.RawMessage `json:"correct_answer_snapshot"`
	MatchedKeywords       json.RawMessage `json:"matched_keywords"`
	KeywordMatchRate      *float64        `json:"keyword_match_rate"`
	GradingDetail         json.RawMessage `json:"grading_detail"`
}

// SubmissionRequest stores a finished submission.
type SubmissionRequest struct {
	UID                FlexInt64          `json:"uid"`
	QuizUUID           string             `json:"quiz_uuid" binding:"required"`
	TotalQuestionCount int                `json:"total_question_count" binding:"gte=0"`
	PassingScore       *int               `json:"passing_score"`
	TotalScore         int                `json:"total_score"`
	CorrectCount       int                `json:"correct_count"`
	Passed             *bool              `json:"passed"`
	TimeSpentSeconds   *int               `json:"time_spent_seconds"`
	Answers            []SubmissionAnswer `json:"answers" binding:"dive"`
}

// CreateTaskRowRequest is the scheduled-quiz task row body.
type CreateTaskRowRequest struct {
	UID               FlexInt64 `json:"uid"`
	TaskID            string    `json:"task_id" binding:"required"`
	Prompt            string    `json:"prompt"`
	Difficulty        string    `json:"difficulty"`
	QuestionCount     int       `json:"question_count" binding:"gte=0"`
	UserEmail         string    `json:"user_email"`
	CCEmails          []string  `json:"cc_emails"`
	IncompleteMessage *string   `json:"incomplete_message"`
}

// MarkGeneratedRequest arms the answer deadline after generation.
type MarkGeneratedRequest struct {
	DeadlineSeconds int `json:"deadline_seconds" binding:"gte=0"`
}

// AgentQuizSetRequest supersets the simple agent payload and the rich draft.
type AgentQuizSetRequest struct {
	UID              FlexInt64        `json:"uid"`
	QuizUUID         string           `json:"quiz_uuid,omitempty"`
	Title            string           `json:"title" binding:"max=200"`
	Difficulty       string           `json:"difficulty,omitempty"`
	QuestionCount    *int             `json:"question_count,omitempty"`
	TypeDistribution map[string]int   `json:"type_distribution,omitempty"`
	FolderIDs        []int64          `json:"folder_ids,omitempty"`
	SourceType       string           `json:"source_type,omitempty"`
	SourcePages      []map[string]any `json:"source_pages,omitempty"`
	ChatSessionID    *string          `json:"chat_session_id,omitempty"`
	Status           string           `json:"status,omitempty"`
	TotalScore       *int             `json:"total_score,omitempty"`
	PassingScore     *int             `json:"passing_score,omitempty"`
	Questions        []AgentQuestion  `json:"questions"`
}

// AgentQuizQuestionsRequest finalizes/appends generated questions.
type AgentQuizQuestionsRequest struct {
	UID            FlexInt64       `json:"uid"`
	Status         string          `json:"status"`
	Questions      []AgentQuestion `json:"questions"`
	QualityMetrics json.RawMessage `json:"quality_metrics,omitempty"`
	BVIDCount      int             `json:"bvid_count,omitempty"`
}

// AgentQuizProgressRequest reports checkpoint progress.
type AgentQuizProgressRequest struct {
	UID    FlexInt64 `json:"uid"`
	Stage  string    `json:"stage"`
	Detail string    `json:"detail"`
	Stored int       `json:"stored"`
	Total  int       `json:"total"`
}

// AgentQuizFailRequest marks a generation failed.
type AgentQuizFailRequest struct {
	UID          FlexInt64 `json:"uid"`
	ErrorMessage string    `json:"error_message"`
}

// ReopenRequest resumes a partial quiz.
type ReopenRequest struct {
	UID FlexInt64 `json:"uid"`
}

// AgentGradingRequest stores AI grading results.
type AgentGradingRequest struct {
	UID         FlexInt64      `json:"uid"`
	QuizUUID    string         `json:"quiz_uuid" binding:"required"`
	Score       int            `json:"score"`
	Total       int            `json:"total"`
	PerQuestion []AgentVerdict `json:"per_question"`
}

// CreateShareRequest is the public-share creation body.
type CreateShareRequest struct {
	ExpiresInDays *json.Number `json:"expires_in_days"`
	Password      string       `json:"password" binding:"max=128"`
}

// RenameRequest renames an owned quiz.
type RenameRequest struct {
	Title string `json:"title" binding:"required,max=200"`
}

// QuotaRequest is the internal quota peek/consume body.
type QuotaRequest struct {
	UID  FlexInt64 `json:"uid"`
	Kind string    `json:"kind" binding:"required,oneof=generate grade"`
}

// TaskAnswerItem is one answer inside the scheduled-quiz answer body.
type TaskAnswerItem struct {
	QuestionIndex int    `json:"question_index" binding:"gte=0"`
	Answer        string `json:"answer"`
}

// TaskAnswerRequest accepts the multi-answer form and the legacy single answer.
type TaskAnswerRequest struct {
	Answers []TaskAnswerItem `json:"answers"`
	Answer  *string          `json:"answer"`
}

// SharePasswordRequest is the public shared-quiz password body.
type SharePasswordRequest struct {
	Password string `json:"password" binding:"max=128"`
}
