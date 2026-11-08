package bootstrap

import (
	"context"

	"app-content/internal/config"
	notemongo "app-content/internal/infra/mongostore/note"
	noterepo "app-content/internal/repo/note"
	noterouter "app-content/internal/router/note"
	noteservice "app-content/internal/service/note"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"gorm.io/gorm"
)

// setupNote wires the note domain onto the shared engine using the process-wide
// MySQL pool and shared Mongo database. Mongo disabled (nil database) degrades
// exactly as before: reads empty, writes 503.
func setupNote(
	ctx context.Context,
	cfg *config.Config,
	engine *gin.Engine,
	db *gorm.DB,
	sharedMongo *mongo.Database,
) (*domain, error) {
	mongoStore := notemongo.NewMongoStore(sharedMongo)
	if err := mongoStore.EnsureIndexes(ctx); err != nil {
		slogWarn("[MONGO] ensure note indexes failed (continuing)", err)
	}
	contentRepo := noterepo.NewMongoContentRepo(mongoStore.Database())
	noterouter.Register(engine, noterouter.Deps{
		Notes:          noteservice.NewNoteService(noterepo.NewNoteRepo(db), contentRepo),
		InternalAPIKey: cfg.Security.InternalAPIKey,
	})

	return &domain{
		name: "note",
		ping: func(ctx context.Context) error {
			if db == nil {
				return nil
			}
			if err := db.WithContext(ctx).Exec("select 1").Error; err != nil {
				return err
			}
			if sharedMongo != nil {
				return sharedMongo.Client().Ping(ctx, nil)
			}
			return nil
		},
	}, nil
}
