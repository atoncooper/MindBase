// Package repo is the quiz data-access layer. One Repo value bundles the two
// handles (MySQL + Mongo); every method takes context.Context first.
package repo

import (
	"go.mongodb.org/mongo-driver/v2/mongo"
	"gorm.io/gorm"
)

// Repo owns the quiz data-store handles for one process.
type Repo struct {
	DB    *gorm.DB
	Mongo *mongo.Database
}

// New builds a repo over the process-wide handles.
func New(db *gorm.DB, mongoDB *mongo.Database) *Repo {
	return &Repo{DB: db, Mongo: mongoDB}
}
