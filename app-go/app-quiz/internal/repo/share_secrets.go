package repo

import (
	"context"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
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
func SaveShareSecret(ctx context.Context, db *mongo.Database, shareToken, quizUUID string, uid int64, passwordHash string) {
	if db == nil {
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
	if _, err := db.Collection(quizShareSecretsCollection).UpdateOne(ctx, filter, update, options.UpdateOne().SetUpsert(true)); err != nil {
		slog.Warn("[QUIZ_SHARE] save secret failed", "err", err)
	}
}

// GetShareSecretHash returns the bcrypt hash for a share token ("" = no password).
func GetShareSecretHash(ctx context.Context, db *mongo.Database, shareToken string) string {
	if db == nil {
		return ""
	}
	var doc ShareSecretDoc
	err := db.Collection(quizShareSecretsCollection).FindOne(ctx, bson.M{"share_token": shareToken}).Decode(&doc)
	if err != nil {
		return ""
	}
	return doc.PasswordHash
}

// DeleteShareSecretByToken removes the secret (revoke / re-share without password).
func DeleteShareSecretByToken(ctx context.Context, db *mongo.Database, shareToken string) {
	if db == nil || shareToken == "" {
		return
	}
	_, _ = db.Collection(quizShareSecretsCollection).DeleteOne(ctx, bson.M{"share_token": shareToken})
}

// DeleteShareSecretByQuiz removes all secrets of one quiz (hard-delete cleanup).
func DeleteShareSecretByQuiz(ctx context.Context, db *mongo.Database, quizUUID string) {
	if db == nil || quizUUID == "" {
		return
	}
	_, _ = db.Collection(quizShareSecretsCollection).DeleteMany(ctx, bson.M{"quiz_uuid": quizUUID})
}
