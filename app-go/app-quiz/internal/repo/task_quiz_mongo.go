// Mongo reads for the scheduled-quiz question bank — port of the read slice of
// app/services/quiz_gen/service.py and app/services/task_quiz_answer.py.
// Question content lives in the shared Mongo database (mind_base), keyed by
// task_id, so detail/answer need no cross-service hop.
package repo

import (
	"context"
	"errors"
	"log/slog"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

const taskQuizQuestionsCollection = "task_quiz_questions"

// taskQuizDoc is the persisted question-bank document: new documents carry a
// questions array, legacy ones keep the fields flat.
type taskQuizDoc struct {
	Questions              []map[string]interface{} `bson:"questions"`
	Question               *string                  `bson:"question"`
	QuestionType           *string                  `bson:"question_type"`
	Options                interface{}              `bson:"options"`
	Answer                 *string                  `bson:"answer"`
	Difficulty             *string                  `bson:"difficulty"`
	AnswerTimeLimitSeconds *int                     `bson:"answer_time_limit_seconds"`
}

// GetTaskQuizQuestions loads the normalized question list for one task.
// Mongo disabled / no document → nil (Python returns an empty list).
func GetTaskQuizQuestions(ctx context.Context, db *mongo.Database, taskID string) []map[string]interface{} {
	if db == nil {
		slog.Warn("[MONGO_TASK_QUIZ] disabled, cannot read questions", "task_id", taskID)
		return nil
	}
	var doc taskQuizDoc
	err := db.Collection(taskQuizQuestionsCollection).FindOne(ctx, bson.M{"task_id": taskID}).Decode(&doc)
	if err != nil {
		if !errors.Is(err, mongo.ErrNoDocuments) {
			slog.Error("[MONGO_TASK_QUIZ] find failed", "task_id", taskID, "err", err)
		}
		return nil
	}
	if len(doc.Questions) > 0 {
		return doc.Questions
	}
	if doc.Question != nil && *doc.Question != "" {
		return []map[string]interface{}{{
			"question":                  *doc.Question,
			"question_type":             doc.QuestionType,
			"options":                   doc.Options,
			"answer":                    doc.Answer,
			"difficulty":                doc.Difficulty,
			"answer_time_limit_seconds": doc.AnswerTimeLimitSeconds,
		}}
	}
	return nil
}
