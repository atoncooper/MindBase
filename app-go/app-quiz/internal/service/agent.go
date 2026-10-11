// Agent / AI-facing quiz writes (app-quiz-mcp → /internal/quiz/*, and the
// app-ts AI generation flows). Validation and orchestration on top of
// repo/agent_writes.go; the caller's uid comes from the gateway-stripped
// X-Uid (the MCP server / app-ts forward the acting identity).
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"app-quiz/internal/repo"
)

// AgentQuestion is one question from the quiz agent or the AI generation flow.
type AgentQuestion struct {
	Question       string          `json:"question"`
	QuestionType   string          `json:"question_type,omitempty"`
	Difficulty     string          `json:"difficulty,omitempty"`
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

// QuizSetDraft is the rich creation input for the async AI generation flows
// (create a generating row first, finalize once questions are generated).
type QuizSetDraft struct {
	QuizUUID         string
	Title            string
	Difficulty       string
	QuestionCount    *int
	TypeDistribution map[string]int
	FolderIDs        []int64
	SourceType       string
	SourcePages      []map[string]interface{}
	ChatSessionID    *string
	Status           string
	TotalScore       *int
	PassingScore     *int
}

var ErrInvalidInput = errors.New("invalid input")

// CreateAgentQuizSet persists a complete agent-generated quiz set (metadata in
// MySQL, questions in Mongo) and returns the quiz_uuid.
func (s *Store) CreateAgentQuizSet(ctx context.Context, uid int64, title string, questions []AgentQuestion) (map[string]interface{}, error) {
	title = strings.TrimSpace(title)
	if uid <= 0 {
		return nil, fmt.Errorf("%w: uid 必填", ErrInvalidInput)
	}
	if title == "" {
		return nil, fmt.Errorf("%w: title 必填", ErrInvalidInput)
	}
	if len([]rune(title)) > 200 {
		return nil, fmt.Errorf("%w: title 过长（上限 200 字符）", ErrInvalidInput)
	}
	if len(questions) == 0 || len(questions) > 20 {
		return nil, fmt.Errorf("%w: questions 数量须在 1-20 之间", ErrInvalidInput)
	}
	if err := validateQuestions(questions); err != nil {
		return nil, err
	}

	total, passing := 100, 60
	quizUUID, err := repo.CreateQuizSet(ctx, s.DB, s.Mongo, repo.QuizSetInput{
		UID:          uid,
		Title:        title,
		Status:       "done",
		SourceType:   "agent",
		TotalScore:   &total,
		PassingScore: &passing,
		Questions:    toRepoQuestions(questions),
	})
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"quiz_uuid": quizUUID, "question_count": len(questions)}, nil
}

// CreateQuizSet creates a quiz set in the generating state (async AI flow);
// questions land later via FinalizeQuizSet, or FailQuizSet marks it failed.
func (s *Store) CreateQuizSet(ctx context.Context, uid int64, draft QuizSetDraft) (map[string]interface{}, error) {
	title := strings.TrimSpace(draft.Title)
	if uid <= 0 {
		return nil, fmt.Errorf("%w: uid 必填", ErrInvalidInput)
	}
	if title == "" {
		return nil, fmt.Errorf("%w: title 必填", ErrInvalidInput)
	}
	if len([]rune(title)) > 200 {
		return nil, fmt.Errorf("%w: title 过长（上限 200 字符）", ErrInvalidInput)
	}
	status := strings.TrimSpace(draft.Status)
	if status == "" {
		status = "generating"
	}
	quizUUID, err := repo.CreateQuizSet(ctx, s.DB, s.Mongo, repo.QuizSetInput{
		UID:              uid,
		QuizUUID:         strings.TrimSpace(draft.QuizUUID),
		Title:            title,
		Difficulty:       draft.Difficulty,
		QuestionCount:    draft.QuestionCount,
		TypeDistribution: draft.TypeDistribution,
		FolderIDs:        draft.FolderIDs,
		SourceType:       draft.SourceType,
		SourcePages:      draft.SourcePages,
		ChatSessionID:    draft.ChatSessionID,
		Status:           status,
		TotalScore:       draft.TotalScore,
		PassingScore:     draft.PassingScore,
	})
	if err != nil {
		return nil, err
	}
	count := 0
	if draft.QuestionCount != nil {
		count = *draft.QuestionCount
	}
	return map[string]interface{}{"quiz_uuid": quizUUID, "question_count": count}, nil
}

// FinalizeQuizSet saves the generated questions and flips the row terminal.
func (s *Store) FinalizeQuizSet(ctx context.Context, uid int64, quizUUID, status string, questions []AgentQuestion, qualityMetrics json.RawMessage, bvidCount int) (map[string]interface{}, error) {
	if uid <= 0 {
		return nil, fmt.Errorf("%w: uid 必填", ErrInvalidInput)
	}
	if strings.TrimSpace(quizUUID) == "" {
		return nil, fmt.Errorf("%w: quiz_uuid 必填", ErrInvalidInput)
	}
	status = strings.TrimSpace(status)
	if status != "done" && status != "partial" {
		status = "done"
	}
	if len(questions) == 0 {
		return nil, fmt.Errorf("%w: questions 不能为空", ErrInvalidInput)
	}
	// 知识库模式允许 question_count 至 50,checkpoint+finalize 一次性携带全部
	// 累计题目 —— 上限须覆盖生成上限(20 是 agent 会话路径的限制,不适用于此)
	if len(questions) > 200 {
		return nil, fmt.Errorf("%w: questions 数量须在 1-200 之间", ErrInvalidInput)
	}
	if err := validateQuestions(questions); err != nil {
		return nil, err
	}
	if err := repo.FinalizeQuizSet(ctx, s.DB, s.Mongo, quizUUID, uid, status, toRepoQuestions(questions), qualityMetrics, bvidCount); err != nil {
		if errors.Is(err, repo.ErrQuizSetNotFound) {
			return nil, ErrInvalidInput
		}
		return nil, err
	}
	return map[string]interface{}{"quiz_uuid": quizUUID, "status": status, "question_count": len(questions)}, nil
}

// AppendQuestions checkpoint 增量落库：仅接受 generating 状态的题卷行
// （终态/删除中拒绝），题目校验与 Finalize 一致。幂等 —— 相同题干重复
// checkpoint 只会替换同一行（Mongo 按 (quiz_uuid, question_text) upsert，
// MySQL 按 question_uuid upsert）。供 app-ts 的分批生成流程逐批持久化，
// 进程中断后超时清扫按已存题数判 partial 而非 failed。
func (s *Store) AppendQuestions(ctx context.Context, uid int64, quizUUID string, questions []AgentQuestion) (map[string]interface{}, error) {
	if uid <= 0 {
		return nil, fmt.Errorf("%w: uid 必填", ErrInvalidInput)
	}
	if strings.TrimSpace(quizUUID) == "" {
		return nil, fmt.Errorf("%w: quiz_uuid 必填", ErrInvalidInput)
	}
	if len(questions) == 0 {
		return nil, fmt.Errorf("%w: questions 不能为空", ErrInvalidInput)
	}
	if len(questions) > 50 {
		return nil, fmt.Errorf("%w: 单次 checkpoint questions 数量须在 1-50 之间", ErrInvalidInput)
	}
	if err := validateQuestions(questions); err != nil {
		return nil, err
	}
	qs, err := repo.GetOwnedQuizSet(s.DB, quizUUID, uid)
	if err != nil {
		return nil, err
	}
	if qs == nil {
		return nil, fmt.Errorf("%w: quiz set 不存在", ErrInvalidInput)
	}
	if deref(qs.Status) != "generating" {
		return nil, apiErr(409, "题卷不在生成中，无法 checkpoint")
	}
	if err := repo.CheckpointQuestions(ctx, s.DB, s.Mongo, quizUUID, uid, toRepoQuestions(questions)); err != nil {
		return nil, err
	}
	return map[string]interface{}{"stored": len(questions)}, nil
}

// FailQuizSet marks a generating quiz set failed with a bounded message.
func (s *Store) FailQuizSet(ctx context.Context, uid int64, quizUUID, message string) (map[string]interface{}, error) {
	if uid <= 0 {
		return nil, fmt.Errorf("%w: uid 必填", ErrInvalidInput)
	}
	if strings.TrimSpace(quizUUID) == "" {
		return nil, fmt.Errorf("%w: quiz_uuid 必填", ErrInvalidInput)
	}
	msg := []rune(strings.TrimSpace(message))
	if len(msg) > 500 {
		msg = msg[:500]
	}
	if len(msg) == 0 {
		msg = []rune("生成失败")
	}
	if err := repo.FailQuizSet(ctx, s.DB, quizUUID, uid, string(msg)); err != nil {
		if errors.Is(err, repo.ErrQuizSetNotFound) {
			return nil, ErrInvalidInput
		}
		return nil, err
	}
	return map[string]interface{}{"quiz_uuid": quizUUID, "status": "failed"}, nil
}

// SaveAgentGrading persists a conversational grading result as a
// quiz_submissions row (no fabricated per-answer rows) and returns the
// submission_uuid.
func (s *Store) SaveAgentGrading(ctx context.Context, uid int64, quizUUID string, score, total int, perQuestion []AgentVerdict) (map[string]interface{}, error) {
	if uid <= 0 {
		return nil, fmt.Errorf("%w: uid 必填", ErrInvalidInput)
	}
	if score < 0 || score > 100 {
		return nil, fmt.Errorf("%w: score 须在 0-100", ErrInvalidInput)
	}
	if total <= 0 {
		return nil, fmt.Errorf("%w: total 必须为正", ErrInvalidInput)
	}
	if len(perQuestion) == 0 {
		return nil, fmt.Errorf("%w: perQuestion 不能为空", ErrInvalidInput)
	}
	for _, v := range perQuestion {
		if v.Verdict != "correct" && v.Verdict != "wrong" && v.Verdict != "partial" {
			return nil, fmt.Errorf("%w: 无效的判定 %q", ErrInvalidInput, v.Verdict)
		}
	}
	// conversational grading may reference a quiz that was never persisted
	// (quiz_uuid optional) — the column is NOT NULL, so empty string stands in
	trimmed := strings.TrimSpace(quizUUID)
	verdicts := make([]repo.AgentVerdict, len(perQuestion))
	for i, v := range perQuestion {
		verdicts[i] = repo.AgentVerdict{Index: v.Index, Verdict: v.Verdict, Feedback: v.Feedback}
	}
	submissionUUID, err := repo.CreateAgentGrading(s.DB, uid, trimmed, score, total, verdicts)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"submission_uuid": submissionUUID}, nil
}

// ── helpers ──────────────────────────────────────────────────────────

func validateQuestions(questions []AgentQuestion) error {
	for i, q := range questions {
		if strings.TrimSpace(q.Question) == "" {
			return fmt.Errorf("%w: 第 %d 题题干为空", ErrInvalidInput, i+1)
		}
		if strings.TrimSpace(q.Answer) == "" && len(q.CorrectAnswer) == 0 {
			return fmt.Errorf("%w: 第 %d 题缺少答案", ErrInvalidInput, i+1)
		}
		if strings.TrimSpace(q.Explanation) == "" {
			return fmt.Errorf("%w: 第 %d 题缺少解析", ErrInvalidInput, i+1)
		}
	}
	return nil
}

func toRepoQuestions(questions []AgentQuestion) []repo.AgentQuestion {
	out := make([]repo.AgentQuestion, len(questions))
	for i, q := range questions {
		out[i] = repo.AgentQuestion{
			Question:       q.Question,
			QuestionType:   q.QuestionType,
			Difficulty:     q.Difficulty,
			Options:        q.Options,
			Answer:         q.Answer,
			CorrectAnswer:  q.CorrectAnswer,
			Explanation:    q.Explanation,
			Keywords:       q.Keywords,
			BVID:           q.BVID,
			ChunkID:        q.ChunkID,
			SourceSegment:  q.SourceSegment,
			AnswerTemplate: q.AnswerTemplate,
			ScoringRubric:  q.ScoringRubric,
			ModelAnswer:    q.ModelAnswer,
		}
	}
	return out
}
