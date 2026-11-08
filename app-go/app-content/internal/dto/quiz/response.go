// Typed HTTP response contracts for the quiz domain. Routers convert the
// service payload into these DTOs (renderTyped) so the wire schema lives here
// instead of being an untyped map at the HTTP boundary.
package quiz

// OK is the generic success envelope for M2M writes.
type OK struct {
	OK bool `json:"ok"`
}

// QuotaStatus is the daily-quota peek/consume response.
type QuotaStatus struct {
	OK   bool   `json:"ok"`
	Kind string `json:"kind"`
}

// HistoryItem is one quiz-history row.
type HistoryItem struct {
	SubmissionUUID     string  `json:"submission_uuid"`
	QuizUUID           string  `json:"quiz_uuid"`
	Title              string  `json:"title"`
	Status             *string `json:"status"`
	ErrorMessage       *string `json:"error_message"`
	QuestionCount      *int    `json:"question_count"`
	Difficulty         *string `json:"difficulty"`
	SourceType         *string `json:"source_type"`
	Score              *int    `json:"score"`
	Passed             *bool   `json:"passed"`
	CorrectCount       *int    `json:"correct_count"`
	TotalQuestionCount *int    `json:"total_question_count"`
	TimeSpentSeconds   *int    `json:"time_spent_seconds"`
	SubmittedAt        any     `json:"submitted_at"`
	CreatedAt          string  `json:"created_at"`
}

// History is GET /quiz/history.
type History struct {
	Submissions []HistoryItem `json:"submissions"`
	Total       int           `json:"total"`
	Page        int           `json:"page"`
	PageSize    int           `json:"page_size"`
	HasMore     bool          `json:"has_more"`
}

// WrongAnswerItem is one wrong-answer notebook row.
type WrongAnswerItem struct {
	QuestionUUID  string  `json:"question_uuid"`
	QuizUUID      string  `json:"quiz_uuid"`
	QuestionType  string  `json:"question_type"`
	Difficulty    string  `json:"difficulty"`
	QuestionText  string  `json:"question_text"`
	Options       any     `json:"options"`
	UserAnswer    any     `json:"user_answer"`
	CorrectAnswer any     `json:"correct_answer"`
	Explanation   *string `json:"explanation"`
	TimesWrong    int     `json:"times_wrong"`
	LastAttemptAt any     `json:"last_attempt_at"`
}

// WrongAnswers is GET /quiz/wrong-answers.
type WrongAnswers struct {
	WrongAnswers []WrongAnswerItem `json:"wrong_answers"`
	Total        int               `json:"total"`
}

// QuizQuestion is one question in the quiz detail payload.
type QuizQuestion struct {
	QuestionUUID  string `json:"question_uuid"`
	QuestionType  string `json:"question_type"`
	Difficulty    string `json:"difficulty"`
	QuestionText  string `json:"question_text"`
	Options       any    `json:"options,omitempty"`
	CorrectAnswer any    `json:"correct_answer,omitempty"`
	Explanation   any    `json:"explanation,omitempty"`
	Keywords      any    `json:"keywords,omitempty"`
}

// QuizDetail is GET /quiz/{uuid}.
type QuizDetail struct {
	QuizUUID           string         `json:"quiz_uuid"`
	Title              string         `json:"title"`
	Status             string         `json:"status"`
	Partial            bool           `json:"partial"`
	ErrorMessage       *string        `json:"error_message"`
	QuestionCount      *int           `json:"question_count"`
	TypeDistribution   any            `json:"type_distribution"`
	Difficulty         *string        `json:"difficulty"`
	TotalScore         *int           `json:"total_score"`
	PassingScore       *int           `json:"passing_score"`
	SourceType         string         `json:"source_type"`
	SourcePages        any            `json:"source_pages"`
	CreatedAt          string         `json:"created_at"`
	Questions          []QuizQuestion `json:"questions"`
	GenerationProgress any            `json:"generation_progress,omitempty"`
}

// ShareState is the owner-side share payload (create/status/revoke share the
// same shape; optional fields are omitted when absent).
type ShareState struct {
	QuizUUID       string `json:"quiz_uuid"`
	Shared         bool   `json:"shared"`
	ShareToken     string `json:"share_token,omitempty"`
	SharedAt       any    `json:"shared_at,omitempty"`
	ShareExpiresAt any    `json:"share_expires_at,omitempty"`
	Expired        *bool  `json:"expired,omitempty"`
	HasPassword    *bool  `json:"has_password,omitempty"`
}

// QuizRef is the small status payload returned by resume/agent writes.
type QuizRef struct {
	QuizUUID       string `json:"quiz_uuid,omitempty"`
	Status         string `json:"status,omitempty"`
	QuestionCount  int    `json:"question_count,omitempty"`
	SubmissionUUID string `json:"submission_uuid,omitempty"`
}

// DeleteResult is DELETE /quiz/{uuid}.
type DeleteResult struct {
	Deleted            bool   `json:"deleted"`
	QuizUUID           string `json:"quiz_uuid"`
	DeletedQuestions   int64  `json:"deleted_questions"`
	DeletedSubmissions int64  `json:"deleted_submissions"`
	DeletedAnswers     int64  `json:"deleted_answers"`
}

// RenameResult is PATCH /quiz/{uuid}.
type RenameResult struct {
	QuizUUID string `json:"quiz_uuid"`
	Title    string `json:"title"`
}

// AgentWriteResult is the common M2M write acknowledgement (agent sets,
// finalize/append/fail, grading).
type AgentWriteResult struct {
	QuizUUID       string `json:"quiz_uuid,omitempty"`
	Status         string `json:"status,omitempty"`
	QuestionCount  int    `json:"question_count,omitempty"`
	SubmissionUUID string `json:"submission_uuid,omitempty"`
}

// GradingSet is the quiz-set metadata part of the grading payload.
type GradingSet struct {
	QuizUUID         string  `json:"quiz_uuid"`
	PassingScore     *int    `json:"passing_score"`
	TotalScore       *int    `json:"total_score"`
	QuestionCount    *int    `json:"question_count"`
	TypeDistribution any     `json:"type_distribution"`
	Difficulty       *string `json:"difficulty"`
	Title            string  `json:"title"`
	SourceType       *string `json:"source_type"`
	Status           *string `json:"status"`
}

// GradingPayload is GET /internal/quiz/grading-payload. Question documents are
// opaque JSON (Mongo docs) but bounded to the known question schema fields.
type GradingPayload struct {
	Set       GradingSet       `json:"set"`
	Questions []map[string]any `json:"questions"`
}

// TaskQuizAnswerView is one persisted answer row.
type TaskQuizAnswerView struct {
	QuestionIndex int    `json:"question_index"`
	Answer        string `json:"answer"`
	IsCorrect     *bool  `json:"is_correct"`
	SubmittedAt   any    `json:"submitted_at,omitempty"`
}

// TaskQuizDetail is the scheduled-quiz detail payload.
type TaskQuizDetail struct {
	TaskID     string               `json:"task_id"`
	Prompt     string               `json:"prompt"`
	Difficulty string               `json:"difficulty"`
	Status     string               `json:"status"`
	Deadline   any                  `json:"deadline"`
	CCEmails   []string             `json:"cc_emails"`
	Quiz       TaskQuizQuestions    `json:"quiz"`
	Answers    []TaskQuizAnswerView `json:"answers"`
}

// TaskQuizQuestions wraps the question documents.
type TaskQuizQuestions struct {
	Questions []map[string]any `json:"questions"`
}

// TaskQuizJudgeView is one judged answer.
type TaskQuizJudgeView struct {
	QuestionIndex int    `json:"question_index"`
	Answer        string `json:"answer"`
	IsCorrect     bool   `json:"is_correct"`
}

// TaskQuizSubmitResult is POST /tasks/{id}/answer.
type TaskQuizSubmitResult struct {
	Status    string              `json:"status"`
	IsCorrect bool                `json:"is_correct"`
	Results   []TaskQuizJudgeView `json:"results"`
}

// SignalsResponse is the blindspot attribution read.
type SignalsResponse struct {
	Signals []map[string]any `json:"signals"`
}
