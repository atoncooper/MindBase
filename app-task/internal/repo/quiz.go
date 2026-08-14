package repo

import (
	"context"

	"app-task/internal/model"
	"app-task/internal/mongo"

	"go.mongodb.org/mongo-driver/bson"
	mgodriver "go.mongodb.org/mongo-driver/mongo"
)

// GetQuizByTaskID returns the quiz doc for a task, or nil if not found.
//
// Quiz content is generated + stored by the MAIN app (mind_base Mongo,
// collection task_quiz_questions); app-task only reads it for the detail
// endpoint. Declared as a package-level variable (func type) so tests can
// swap it with a stub, avoiding the need for a real MongoDB.
var GetQuizByTaskID = func(ctx context.Context, taskID string) (map[string]any, error) {
	sr := mongo.DB.Collection(model.TaskQuizCollection).FindOne(ctx, bson.M{"task_id": taskID})
	var m map[string]any
	if err := sr.Decode(&m); err != nil {
		if err == mgodriver.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}
	delete(m, "_id")
	return m, nil
}
