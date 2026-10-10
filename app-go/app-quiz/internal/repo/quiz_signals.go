// Quiz signal reads for the blindspot attribution face (/internal/quiz/quiz-signals):
// the user's recent answered questions with their LLM-tagged related entities.
// Read-only over quiz_submissions / quiz_answers (MySQL) + quiz_questions (Mongo).
package repo

import (
	"context"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"gorm.io/gorm"
)

// QuizSignal is one answered question: correctness + entity attribution.
type QuizSignal struct {
	QuizUUID        string   `json:"quiz_uuid"`
	QuestionUUID    string   `json:"question_uuid"`
	IsCorrect       bool     `json:"is_correct"`
	QuestionText    string   `json:"question_text"`
	RelatedEntities []string `json:"related_entities"`
}

// ListQuizSignalSubmissions returns the user's recent submission→quiz pairs.
func ListQuizSignalSubmissions(ctx context.Context, db *gorm.DB, uid int64, limit int) ([]struct {
	SubmissionUUID string
	QuizUUID       string
}, error) {
	if limit <= 0 {
		limit = 200
	}
	type row struct {
		SubmissionUUID string `gorm:"column:submission_uuid"`
		QuizUUID       string `gorm:"column:quiz_uuid"`
	}
	var rows []row
	err := db.WithContext(ctx).Raw(
		"SELECT submission_uuid, quiz_uuid FROM quiz_submissions WHERE uid = ? ORDER BY id DESC LIMIT ?",
		uid, limit,
	).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	out := make([]struct {
		SubmissionUUID string
		QuizUUID       string
	}, 0, len(rows))
	for _, r := range rows {
		out = append(out, struct {
			SubmissionUUID string
			QuizUUID       string
		}{r.SubmissionUUID, r.QuizUUID})
	}
	return out, nil
}

// ListQuizSignalAnswers returns (submission_uuid, question_uuid, is_correct)
// for the given submissions.
func ListQuizSignalAnswers(ctx context.Context, db *gorm.DB, submissionUUIDs []string) ([]struct {
	SubmissionUUID string
	QuestionUUID   string
	IsCorrect      bool
}, error) {
	if len(submissionUUIDs) == 0 {
		return nil, nil
	}
	type row struct {
		SubmissionUUID string `gorm:"column:submission_uuid"`
		QuestionUUID   string `gorm:"column:question_uuid"`
		IsCorrect      bool   `gorm:"column:is_correct"`
	}
	var rows []row
	err := db.WithContext(ctx).Raw(
		"SELECT submission_uuid, question_uuid, is_correct FROM quiz_answers WHERE submission_uuid IN (?)",
		submissionUUIDs,
	).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	out := make([]struct {
		SubmissionUUID string
		QuestionUUID   string
		IsCorrect      bool
	}, 0, len(rows))
	for _, r := range rows {
		out = append(out, struct {
			SubmissionUUID string
			QuestionUUID   string
			IsCorrect      bool
		}{r.SubmissionUUID, r.QuestionUUID, r.IsCorrect})
	}
	return out, nil
}

// GetQuestionAttributions batch-reads entity attributions from Mongo
// (port of mongo_quiz_repository.get_question_attributions).
func GetQuestionAttributions(ctx context.Context, db *mongo.Database, quizUUIDs []string) (map[string]struct {
	RelatedEntities []string
	QuestionText    string
}, error) {
	out := make(map[string]struct {
		RelatedEntities []string
		QuestionText    string
	})
	if db == nil || len(quizUUIDs) == 0 {
		return out, nil
	}
	cursor, err := db.Collection(quizQuestionsCollection).Find(ctx, bson.M{
		"quiz_uuid": bson.M{"$in": quizUUIDs},
		"is_valid":  true,
	}, options.Find().SetProjection(bson.D{
		{Key: "question_uuid", Value: 1},
		{Key: "quiz_uuid", Value: 1},
		{Key: "related_entities", Value: 1},
		{Key: "question_text", Value: 1},
		{Key: "_id", Value: 0},
	}).SetLimit(1000))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var doc struct {
			QuestionUUID    string   `bson:"question_uuid"`
			QuizUUID        string   `bson:"quiz_uuid"`
			RelatedEntities []string `bson:"related_entities"`
			QuestionText    string   `bson:"question_text"`
		}
		if err := cursor.Decode(&doc); err != nil {
			continue
		}
		if doc.RelatedEntities == nil {
			doc.RelatedEntities = []string{}
		}
		out[doc.QuestionUUID] = struct {
			RelatedEntities []string
			QuestionText    string
		}{doc.RelatedEntities, doc.QuestionText}
	}
	return out, cursor.Err()
}
