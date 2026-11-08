package repo

import (
	"context"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// quizShareSecretsCollection stores bcrypt password hashes for password-protected
// quiz shares. MySQL quiz_sets is CREATE-TABLE-IF-NOT-EXISTS only（从不 ALTER），
// 所以访问口令落 Mongo（app-quiz 自有域，与 quiz_questions 同库）。
const quizShareSecretsCollection = "quiz_share_secrets"

type ShareSecretDoc struct {
	ShareToken   string    `bson:"share_token"`
	QuizUUID     string    `bson:"quiz_uuid"`
	UID          int64     `bson:"uid"`
	PasswordHash string    `bson:"password_hash"`
	CreatedAt    time.Time `bson:"created_at"`
}

// SaveShareSecret upserts the password hash for a share token（重建分享时覆盖）。
func (r *Repo) SaveShareSecret(ctx context.Context, shareToken, quizUUID string, uid int64, passwordHash string) {
	if r.Mongo == nil {
		return
	}
	filter := bson.M{"share_token": shareToken}
	update := bson.M{"$set": bson.M{
		"share_token":   shareToken,
		"quiz_uuid":     quizUUID,
		"uid":           uid,
		"password_hash": passwordHash,
		"created_at":    time.Now().UTC(),
	}}
	if _, err := r.Mongo.Collection(quizShareSecretsCollection).UpdateOne(ctx, filter, update, options.UpdateOne().SetUpsert(true)); err != nil {
		slog.Warn("[QUIZ_SHARE] save secret failed", "err", err)
	}
}

// GetShareSecretHash returns the bcrypt hash for a share token ("" = no password).
func (r *Repo) GetShareSecretHash(ctx context.Context, shareToken string) string {
	if r.Mongo == nil {
		return ""
	}
	var doc ShareSecretDoc
	err := r.Mongo.Collection(quizShareSecretsCollection).FindOne(ctx, bson.M{"share_token": shareToken}).Decode(&doc)
	if err != nil {
		return ""
	}
	return doc.PasswordHash
}

// DeleteShareSecretByToken removes the secret (revoke / re-share without password).
func (r *Repo) DeleteShareSecretByToken(ctx context.Context, shareToken string) {
	if r.Mongo == nil || shareToken == "" {
		return
	}
	_, _ = r.Mongo.Collection(quizShareSecretsCollection).DeleteOne(ctx, bson.M{"share_token": shareToken})
}

// DeleteShareSecretByQuiz removes all secrets of one quiz (hard-delete cleanup).
func (r *Repo) DeleteShareSecretByQuiz(ctx context.Context, quizUUID string) {
	if r.Mongo == nil || quizUUID == "" {
		return
	}
	_, _ = r.Mongo.Collection(quizShareSecretsCollection).DeleteMany(ctx, bson.M{"quiz_uuid": quizUUID})
}
