package repo

import (
	"context"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// quizProgressCollection stores the app-ts generation pipeline step log (one
// doc per quiz). The frontend reads it back through GET /quiz/{uuid} while the
// set is "generating" — 渐进式执行步骤可视化（规划/检索/逐批生成/落库）。
const quizProgressCollection = "quiz_generation_progress"

// GenerationProgressEntry is one pipeline step in the visible log.
type GenerationProgressEntry struct {
	Stage  string `json:"stage"`
	Detail string `json:"detail"`
	At     string `json:"at"`
}

// GenerationProgress is the upserted progress doc.
type GenerationProgress struct {
	QuizUUID  string                    `json:"quiz_uuid" bson:"quiz_uuid"`
	UID       int64                     `json:"uid" bson:"uid"`
	Stage     string                    `json:"stage" bson:"stage"`
	Detail    string                    `json:"detail" bson:"detail"`
	Stored    int                       `json:"stored" bson:"stored"`
	Total     int                       `json:"total" bson:"total"`
	Log       []GenerationProgressEntry `json:"log" bson:"log,omitempty"`
	UpdatedAt time.Time                 `json:"updated_at" bson:"updated_at"`
}

// SaveGenerationProgress upserts the doc and appends the step to a capped log
// (last 12 entries — enough for the UI, bounded growth).
func (r *Repo) SaveGenerationProgress(ctx context.Context, p GenerationProgress) {
	if r.Mongo == nil {
		return
	}
	entry := GenerationProgressEntry{Stage: p.Stage, Detail: p.Detail, At: p.UpdatedAt.UTC().Format(time.RFC3339)}
	update := bson.M{
		"$set": bson.M{
			"quiz_uuid":  p.QuizUUID,
			"uid":        p.UID,
			"stage":      p.Stage,
			"detail":     p.Detail,
			"stored":     p.Stored,
			"total":      p.Total,
			"updated_at": p.UpdatedAt,
		},
		"$push": bson.M{"log": bson.M{"$each": []GenerationProgressEntry{entry}, "$slice": -12}},
	}
	if _, err := r.Mongo.Collection(quizProgressCollection).UpdateOne(
		ctx, bson.M{"quiz_uuid": p.QuizUUID}, update, options.UpdateOne().SetUpsert(true),
	); err != nil {
		// 进度上报失败不影响生成（前端只是看不到步骤）
		slog.Warn("[QUIZ_PROGRESS] save failed", "quiz_uuid", p.QuizUUID, "err", err)
	}
}

// GetGenerationProgress returns the doc for one quiz (nil when absent / Mongo off).
func (r *Repo) GetGenerationProgress(ctx context.Context, quizUUID string) *GenerationProgress {
	if r.Mongo == nil {
		return nil
	}
	var p GenerationProgress
	err := r.Mongo.Collection(quizProgressCollection).FindOne(ctx, bson.M{"quiz_uuid": quizUUID},
		options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 0}})).Decode(&p)
	if err != nil {
		return nil
	}
	return &p
}

// DeleteGenerationProgress removes the doc (quiz hard-delete cleanup).
func (r *Repo) DeleteGenerationProgress(ctx context.Context, quizUUID string) {
	if r.Mongo == nil {
		return
	}
	_, _ = r.Mongo.Collection(quizProgressCollection).DeleteOne(ctx, bson.M{"quiz_uuid": quizUUID})
}
