// Agent / AI-facing quiz writes: quiz sets, question content and gradings.
// The simple agent path (app-quiz-mcp save_quiz/save_grading) and the async AI
// generation flows (create generating → finalize questions, or fail) share
// these primitives. Insert shapes mirror the Python generation slice
// (quiz_from_summary.py / quiz_grader.py) so history / detail / wrong-answer
// reads keep working.
package repo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"gorm.io/gorm"
)

// ErrQuizSetNotFound: the quiz_sets row is missing or not owned by the caller.
var ErrQuizSetNotFound = errors.New("quiz set not found")

func boolPtr(v bool) *bool { return &v }

// AgentQuestion is one question from the quiz agent or the AI generation flow.
// The rich fields are optional; when omitted the legacy derivation applies
// (options → single_choice, else short_answer; difficulty medium).
type AgentQuestion struct {
	Question     string `json:"question"`
	QuestionType string `json:"question_type,omitempty"`
	Difficulty   string `json:"difficulty,omitempty"`
	// Score 每题分值（蓝本固有；0/缺省 = 无分值语义，读取侧均分兜底）
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

// AgentVerdict is one per-question verdict from the quiz agent's grading.
type AgentVerdict struct {
	Index    int    `json:"index"`
	Verdict  string `json:"verdict"` // correct | wrong | partial
	Feedback string `json:"feedback"`
}

// QuizSetInput is the storage input for one quiz_sets row plus (optionally)
// its Mongo question documents.
type QuizSetInput struct {
	UID              int64
	QuizUUID         string // caller-supplied id (empty → generated)
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
	QualityMetrics   json.RawMessage
	BVIDCount        int
	Questions        []AgentQuestion
}

// CreateQuizSet inserts the quiz_sets row. status defaults to "done"; the async
// AI flows first create it as "generating" and finalize later. Questions, when
// provided, are upserted into Mongo immediately (agent path).
func CreateQuizSet(ctx context.Context, db *gorm.DB, mdb *mongo.Database, in QuizSetInput) (string, error) {
	quizUUID := strings.TrimSpace(in.QuizUUID)
	if quizUUID == "" {
		quizUUID = uuid.NewString()
	}
	status := strings.TrimSpace(in.Status)
	if status == "" {
		status = "done"
	}
	difficulty := strings.TrimSpace(in.Difficulty)
	if difficulty == "" {
		difficulty = "medium"
	}
	sourceType := strings.TrimSpace(in.SourceType)
	if sourceType == "" {
		sourceType = "agent"
	}
	questionCount := len(in.Questions)
	if in.QuestionCount != nil {
		questionCount = *in.QuestionCount
	}

	dist := in.TypeDistribution
	if dist == nil {
		dist = deriveTypeDistribution(in.Questions)
	}
	distJSON, err := json.Marshal(dist)
	if err != nil {
		return "", fmt.Errorf("marshal type_distribution: %w", err)
	}
	folderIDs := in.FolderIDs
	if folderIDs == nil {
		folderIDs = []int64{}
	}
	folderJSON, err := json.Marshal(folderIDs)
	if err != nil {
		return "", fmt.Errorf("marshal folder_ids: %w", err)
	}
	var sourcePages interface{}
	if len(in.SourcePages) > 0 {
		raw, err := json.Marshal(in.SourcePages)
		if err != nil {
			return "", fmt.Errorf("marshal source_pages: %w", err)
		}
		sourcePages = string(raw)
	}
	var quality interface{}
	if len(in.QualityMetrics) > 0 && string(in.QualityMetrics) != "null" {
		quality = string(in.QualityMetrics)
	}
	now := time.Now().UTC()
	var completedAt interface{}
	if status == "done" || status == "partial" {
		completedAt = now
	}

	err = db.WithContext(ctx).Exec(
		"INSERT INTO quiz_sets "+
			"(quiz_uuid, uid, title, question_count, type_distribution, difficulty, folder_ids, "+
			"source_type, source_pages, chat_session_id, status, total_score, passing_score, "+
			"bvid_count, quality_metrics, completed_at, created_at, updated_at) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		quizUUID, in.UID, in.Title, questionCount, string(distJSON), difficulty, string(folderJSON),
		sourceType, sourcePages, in.ChatSessionID, status, in.TotalScore, in.PassingScore,
		in.BVIDCount, quality, completedAt, now, now,
	).Error
	if err != nil {
		return "", fmt.Errorf("insert quiz_sets: %w", err)
	}

	if len(in.Questions) > 0 {
		uuids := make([]string, len(in.Questions))
		for i := range uuids {
			uuids[i] = uuid.NewString()
		}
		if err := SaveAgentQuestions(ctx, mdb, quizUUID, in.UID, in.Questions, uuids); err != nil {
			return "", err
		}
		for i, q := range in.Questions {
			if err := insertQuestionMetadata(db, quizUUID, q, uuids[i], now); err != nil {
				return "", err
			}
		}
	}
	return quizUUID, nil
}

// deriveTypeDistribution matches the legacy agent behaviour when the caller
// does not pass an explicit distribution.
func deriveTypeDistribution(questions []AgentQuestion) map[string]int {
	dist := map[string]int{}
	for _, q := range questions {
		dist[effectiveQuestionType(q)]++
	}
	return dist
}

func effectiveQuestionType(q AgentQuestion) string {
	if t := strings.TrimSpace(q.QuestionType); t != "" {
		return t
	}
	if len(q.Options) > 0 {
		return "single_choice"
	}
	return "short_answer"
}

// SaveAgentQuestions bulk-upserts the questions into the Mongo quiz_questions
// collection (idempotent by (quiz_uuid, question_text), same as the previous
// agent implementation). Mongo disabled → ErrContentDisabled.
// SaveAgentQuestions bulk-upserts the questions into the Mongo quiz_questions
// collection (idempotent by (quiz_uuid, question_text), same as the previous
// agent implementation). questionUUIDs are generated by the caller and shared
// with the MySQL metadata rows (wrong-answer notebook / export JOIN on them).
// Mongo disabled → ErrContentDisabled.
func SaveAgentQuestions(ctx context.Context, mdb *mongo.Database, quizUUID string, uid int64, questions []AgentQuestion, questionUUIDs []string) error {
	if mdb == nil {
		return ErrContentDisabled
	}
	if len(questionUUIDs) != len(questions) {
		return fmt.Errorf("question uuids (%d) 与 questions (%d) 数量不一致", len(questionUUIDs), len(questions))
	}
	now := time.Now().UTC()
	ops := make([]mongo.WriteModel, 0, len(questions))
	for i, q := range questions {
		// mongo-driver v2: Update*Model 必须带 $ 操作符;整文档替换必须用
		// ReplaceOneModel(v1 的隐式替换语义在 v2 会报 "update document must
		// contain key beginning with '$'")
		ops = append(ops, mongo.NewReplaceOneModel().
			SetFilter(map[string]interface{}{"quiz_uuid": quizUUID, "question_text": q.Question}).
			SetReplacement(buildQuestionDoc(quizUUID, uid, q, now, questionUUIDs[i])).
			SetUpsert(true))
	}
	if len(ops) == 0 {
		return nil
	}
	if _, err := mdb.Collection(quizQuestionsCollection).BulkWrite(ctx, ops, options.BulkWrite().SetOrdered(false)); err != nil {
		return fmt.Errorf("save questions: %w", err)
	}
	return nil
}

// insertQuestionMetadata upserts the MySQL quiz_questions row (idempotent by
// question_uuid) so history / wrong-answer notebook / export JOINs resolve.
func insertQuestionMetadata(db *gorm.DB, quizUUID string, q AgentQuestion, questionUUID string, now time.Time) error {
	var optionsMeta, correctMeta, keywordsMeta, rubricMeta interface{}
	if len(q.Options) > 0 {
		if raw, err := json.Marshal(q.Options); err == nil {
			optionsMeta = string(raw)
		}
	}
	if len(q.CorrectAnswer) > 0 && string(q.CorrectAnswer) != "null" {
		correctMeta = string(q.CorrectAnswer)
	} else if q.Answer != "" {
		correctMeta = q.Answer
	}
	if len(q.Keywords) > 0 {
		if raw, err := json.Marshal(q.Keywords); err == nil {
			keywordsMeta = string(raw)
		}
	}
	if len(q.ScoringRubric) > 0 && string(q.ScoringRubric) != "null" {
		rubricMeta = string(q.ScoringRubric)
	}
	res := db.Exec(
		"INSERT INTO quiz_questions "+
			"(quiz_uuid, question_uuid, bvid, chunk_id, source_segment, question_type, difficulty, "+
			"question_text, options, correct_answer, explanation, keywords, "+
			"answer_template, scoring_rubric, model_answer, is_valid, created_at) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?) "+
			"ON DUPLICATE KEY UPDATE question_text = VALUES(question_text), options = VALUES(options), "+
			"correct_answer = VALUES(correct_answer), explanation = VALUES(explanation), "+
			"keywords = VALUES(keywords), difficulty = VALUES(difficulty), "+
			"bvid = VALUES(bvid), chunk_id = VALUES(chunk_id), source_segment = VALUES(source_segment), "+
			"answer_template = VALUES(answer_template), scoring_rubric = VALUES(scoring_rubric), model_answer = VALUES(model_answer)",
		quizUUID, questionUUID, q.BVID, q.ChunkID, q.SourceSegment, effectiveQuestionType(q),
		strings.TrimSpace(q.Difficulty), q.Question, optionsMeta, correctMeta, q.Explanation,
		keywordsMeta, q.AnswerTemplate, rubricMeta, q.ModelAnswer, now,
	)
	if res.Error != nil {
		return fmt.Errorf("insert quiz_questions metadata: %w", res.Error)
	}
	return nil
}

// buildQuestionDoc mirrors app/repository/mongo_quiz_repository.insert_questions:
// list fields are stored as JSON strings; correct_answer keeps a bare string
// as-is.
func buildQuestionDoc(quizUUID string, uid int64, q AgentQuestion, now time.Time, questionUUID string) map[string]interface{} {
	var optionsJSON interface{}
	if len(q.Options) > 0 {
		if raw, err := json.Marshal(q.Options); err == nil {
			optionsJSON = string(raw)
		}
	}
	correct := interface{}(nil)
	switch {
	case len(q.CorrectAnswer) > 0 && string(q.CorrectAnswer) != "null":
		var v interface{}
		if err := json.Unmarshal(q.CorrectAnswer, &v); err == nil {
			if s, ok := v.(string); ok {
				correct = s
			} else if raw, err := json.Marshal(v); err == nil {
				correct = string(raw)
			}
		}
	case q.Answer != "":
		correct = q.Answer
	}
	var keywordsJSON interface{}
	if len(q.Keywords) > 0 {
		if raw, err := json.Marshal(q.Keywords); err == nil {
			keywordsJSON = string(raw)
		}
	}
	difficulty := strings.TrimSpace(q.Difficulty)
	if difficulty == "" {
		difficulty = "medium"
	}
	var rubricMeta interface{}
	if len(q.ScoringRubric) > 0 && string(q.ScoringRubric) != "null" {
		rubricMeta = string(q.ScoringRubric)
	}
	return map[string]interface{}{
		"question_uuid":    questionUUID,
		"quiz_uuid":        quizUUID,
		"uid":              uid,
		"question_type":    effectiveQuestionType(q),
		"difficulty":       difficulty,
		"score":            q.Score,
		"question_text":    q.Question,
		"options":          optionsJSON,
		"correct_answer":   correct,
		"explanation":      q.Explanation,
		"keywords":         keywordsJSON,
		"bvid":             q.BVID,
		"chunk_id":         q.ChunkID,
		"source_segment":   q.SourceSegment,
		"answer_template":  q.AnswerTemplate,
		"scoring_rubric":   rubricMeta,
		"model_answer":     q.ModelAnswer,
		"related_entities": "[]",
		"is_valid":         true,
		"created_at":       now,
	}
}

// CheckpointQuestions incrementally persists a batch of validated questions
// for a quiz_set that is still in the "generating" state (the generation
// checkpoint). Writes BOTH stores exactly like FinalizeQuizSet's write half:
// Mongo upsert by (quiz_uuid, question_text), MySQL metadata upsert.
// Idempotent — re-checkpointing the same texts replaces the same rows. The
// terminal status is NOT touched; FinalizeQuizSet closes the flow (and
// reuses these uuids).
func CheckpointQuestions(ctx context.Context, db *gorm.DB, mdb *mongo.Database, quizUUID string, uid int64, questions []AgentQuestion) error {
	now := time.Now().UTC()
	existingUUIDs := mapQuestionUUIDsByText(ctx, mdb, quizUUID)
	questionUUIDs := make([]string, len(questions))
	for i := range questionUUIDs {
		if id, ok := existingUUIDs[questions[i].Question]; ok && id != "" {
			questionUUIDs[i] = id
		} else {
			questionUUIDs[i] = uuid.NewString()
		}
	}
	if err := SaveAgentQuestions(ctx, mdb, quizUUID, uid, questions, questionUUIDs); err != nil {
		return err
	}
	for i, q := range questions {
		if err := insertQuestionMetadata(db, quizUUID, q, questionUUIDs[i], now); err != nil {
			return err
		}
	}
	return nil
}

// mapQuestionUUIDsByText reads the existing {question_text → question_uuid}
// mapping for a quiz from Mongo. Empty map when Mongo is disabled or the
// quiz has no checkpointed questions yet.
func mapQuestionUUIDsByText(ctx context.Context, mdb *mongo.Database, quizUUID string) map[string]string {
	out := map[string]string{}
	if mdb == nil {
		return out
	}
	cursor, err := mdb.Collection(quizQuestionsCollection).Find(ctx,
		bson.M{"quiz_uuid": quizUUID, "is_valid": true},
		options.Find().SetProjection(bson.D{{Key: "question_text", Value: 1}, {Key: "question_uuid", Value: 1}, {Key: "_id", Value: 0}}).SetLimit(500),
	)
	if err != nil {
		return out
	}
	var docs []struct {
		QuestionText string `bson:"question_text"`
		QuestionUUID string `bson:"question_uuid"`
	}
	if err := cursor.All(ctx, &docs); err != nil {
		return out
	}
	for _, d := range docs {
		if d.QuestionText != "" && d.QuestionUUID != "" {
			out[d.QuestionText] = d.QuestionUUID
		}
	}
	return out
}

// FinalizeQuizSet persists the generated questions and flips the row to a
// terminal status (done / partial), mirroring quiz_from_summary finalization.
// With checkpointing enabled the generation flow may have already persisted
// questions incrementally; uuids of texts that already exist are REUSED here so
// the MySQL metadata upsert (keyed by question_uuid) updates the checkpoint
// rows instead of duplicating them.
func FinalizeQuizSet(ctx context.Context, db *gorm.DB, mdb *mongo.Database, quizUUID string, uid int64, status string, questions []AgentQuestion, qualityMetrics json.RawMessage, bvidCount int) error {
	now := time.Now().UTC()
	// uuid 由本函数统一生成:Mongo 文档与 MySQL 元数据行必须共用同一个
	// question_uuid(错题本/导出按它 JOIN)。checkpoint 已落库的题干复用其
	// 既有 uuid(Mongo 按 (quiz_uuid, question_text) upsert,MySQL 按
	// question_uuid upsert —— 文本相同即同一条题)。
	existing := mapQuestionUUIDsByText(ctx, mdb, quizUUID)
	questionUUIDs := make([]string, len(questions))
	for i := range questionUUIDs {
		if id, ok := existing[questions[i].Question]; ok && id != "" {
			questionUUIDs[i] = id
		} else {
			questionUUIDs[i] = uuid.NewString()
		}
	}
	if len(questions) > 0 {
		if err := SaveAgentQuestions(ctx, mdb, quizUUID, uid, questions, questionUUIDs); err != nil {
			return err
		}
	}
	// MySQL quiz_questions 元数据(历史/错题本/导出的 JOIN 依赖本表;
	// 题目正文在 Mongo,本表只存展示与关联所需字段)
	for i, q := range questions {
		if err := insertQuestionMetadata(db, quizUUID, q, questionUUIDs[i], now); err != nil {
			return err
		}
	}
	var quality interface{}
	if len(qualityMetrics) > 0 && string(qualityMetrics) != "null" {
		quality = string(qualityMetrics)
	}
	res := db.WithContext(ctx).Exec(
		"UPDATE quiz_sets SET status = ?, question_count = ?, quality_metrics = COALESCE(?, quality_metrics), "+
			"bvid_count = ?, completed_at = ?, updated_at = ? WHERE quiz_uuid = ? AND uid = ?",
		status, len(questions), quality, bvidCount, now, now, quizUUID, uid,
	)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrQuizSetNotFound
	}
	return nil
}

// FailQuizSet marks a generating row failed with a sanitized message.
func FailQuizSet(ctx context.Context, db *gorm.DB, quizUUID string, uid int64, message string) error {
	res := db.WithContext(ctx).Exec(
		"UPDATE quiz_sets SET status = 'failed', error_message = ?, updated_at = ? WHERE quiz_uuid = ? AND uid = ?",
		message, time.Now().UTC(), quizUUID, uid,
	)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrQuizSetNotFound
	}
	return nil
}

// CreateAgentGrading inserts a quiz_submissions row for an agent-produced
// grading (conversational grading has no per-answer rows — quiz_answers stays
// untouched so the wrong-answer notebook is not polluted by fabricated
// answers). Returns the submission_uuid.
func CreateAgentGrading(db *gorm.DB, uid int64, quizUUID string, score, total int, perQuestion []AgentVerdict) (string, error) {
	submissionUUID := uuid.NewString()
	now := time.Now().UTC()
	correct := 0
	for _, v := range perQuestion {
		if v.Verdict == "correct" {
			correct++
		}
	}
	passingScore := 60
	err := db.Exec(
		"INSERT INTO quiz_submissions "+
			"(submission_uuid, quiz_uuid, uid, total_score, auto_score, passing_score, "+
			"is_complete, is_passed, correct_count, total_question_count, submitted_at, graded_at) "+
			"VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)",
		submissionUUID, quizUUID, uid, score, score, passingScore,
		score >= passingScore, correct, total, now, now,
	).Error
	if err != nil {
		return "", fmt.Errorf("insert quiz_submissions: %w", err)
	}
	return submissionUUID, nil
}
