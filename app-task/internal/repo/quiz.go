package repo

import (
	"context"

	"app-task/internal/model"
	"app-task/internal/mongo"

	"go.mongodb.org/mongo-driver/bson"
	mgodriver "go.mongodb.org/mongo-driver/mongo"
)

// InsertQuiz stores generated quiz content in MongoDB.
//
// Package-level variable (func type) so tests can stub it without a real
// MongoDB (ExecuteQuiz tests inject a no-op here).
var InsertQuiz = func(ctx context.Context, doc map[string]any) error {
	_, err := mongo.DB.Collection(model.TaskQuizCollection).InsertOne(ctx, doc)
	return err
}

// GetQuizByTaskID returns the quiz doc for a task, or nil if not found.
//
// Declared as a package-level variable (func type) so tests can swap it
// with a stub, avoiding the need for a real MongoDB in SubmitAnswer
// full-path tests.
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
