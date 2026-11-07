// Mongo question reads — port of app/repository/mongo_quiz_repository.py
// (the read/delete slice app-quiz needs). Question content for quizzes
// generated after the Mongo migration lives ONLY here; the MySQL
// quiz_questions table is a legacy mirror still joined by the wrong-answer
// notebook and export queries.
//
// All operations degrade gracefully on a nil database (Mongo disabled):
// reads return empty results, delete returns ErrContentDisabled.
package repo

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// ErrContentDisabled is returned by writes when Mongo is not connected.
var ErrContentDisabled = errors.New("mongodb is not connected")

const quizQuestionsCollection = "quiz_questions"

// QuestionDoc is one decoded Mongo question document. Field values keep
// their native BSON shape and are marshalled to JSON at the wire boundary
// (parity with the Python backend passing Mongo-native values through
// FastAPI's jsonable_encoder).
type QuestionDoc map[string]interface{}

// GetQuestions returns questions WITHOUT answers (quiz display /
// public share view). Port of mongo_quiz_repository.get_questions.
func GetQuestions(ctx context.Context, db *mongo.Database, quizUUID string) []QuestionDoc {
	if db == nil {
		slog.Warn("[MONGO_QUIZ] disabled, cannot read questions", "quiz_uuid", quizUUID)
		return nil
	}
	projection := bson.D{
		{Key: "question_uuid", Value: 1},
		{Key: "question_type", Value: 1},
		{Key: "difficulty", Value: 1},
		{Key: "question_text", Value: 1},
		{Key: "options", Value: 1},
		{Key: "_id", Value: 0},
	}
	return findQuestions(ctx, db, quizUUID, projection)
}

// GetQuestionsFull returns questions WITH answers (review / include_answers).
// Port of mongo_quiz_repository.get_questions_full.
func GetQuestionsFull(ctx context.Context, db *mongo.Database, quizUUID string) []QuestionDoc {
	if db == nil {
		slog.Warn("[MONGO_QUIZ] disabled, cannot read full questions", "quiz_uuid", quizUUID)
		return nil
	}
	return findQuestions(ctx, db, quizUUID, bson.D{{Key: "_id", Value: 0}})
}

func findQuestions(ctx context.Context, db *mongo.Database, quizUUID string, projection bson.D) []QuestionDoc {
	cursor, err := db.Collection(quizQuestionsCollection).Find(ctx,
		bson.M{"quiz_uuid": quizUUID, "is_valid": true},
		options.Find().SetProjection(projection).SetLimit(200),
	)
	if err != nil {
		slog.Error("[MONGO_QUIZ] find failed", "quiz_uuid", quizUUID, "err", err)
		return nil
	}
	var docs []QuestionDoc
	if err := cursor.All(ctx, &docs); err != nil {
		slog.Error("[MONGO_QUIZ] decode failed", "quiz_uuid", quizUUID, "err", err)
		return nil
	}
	return docs
}

// CountQuestions counts valid questions for a quiz. Returns -1 when Mongo is
// disabled (unknown — callers skip stale checks), mirroring the Python
// repository.
func CountQuestions(ctx context.Context, db *mongo.Database, quizUUID string) int {
	if db == nil {
		return -1
	}
	n, err := db.Collection(quizQuestionsCollection).CountDocuments(ctx,
		bson.M{"quiz_uuid": quizUUID, "is_valid": true})
	if err != nil {
		slog.Error("[MONGO_QUIZ] count failed", "quiz_uuid", quizUUID, "err", err)
		return -1
	}
	return int(n)
}

// DeleteByQuiz deletes all question docs for a quiz (uid-scoped). Returns
// ErrContentDisabled when Mongo is not connected and requireEnabled is set —
// the delete flow must never proceed half-done.
func DeleteByQuiz(ctx context.Context, db *mongo.Database, quizUUID string, uid int64, requireEnabled bool) (int64, error) {
	if db == nil {
		if requireEnabled {
			return 0, ErrContentDisabled
		}
		return 0, nil
	}
	res, err := db.Collection(quizQuestionsCollection).
		DeleteMany(ctx, bson.M{"quiz_uuid": quizUUID, "uid": uid})
	if err != nil {
		return 0, err
	}
	slog.Info("[MONGO_QUIZ] deleted questions", "quiz_uuid", quizUUID, "uid", uid, "count", res.DeletedCount)
	return res.DeletedCount, nil
}

// rawJSON marshals v for wire output; nil → JSON null.
func rawJSON(v interface{}) json.RawMessage {
	if v == nil {
		return json.RawMessage("null")
	}
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("null")
	}
	return b
}
