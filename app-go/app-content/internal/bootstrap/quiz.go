package bootstrap

import (
	"context"
	"time"

	"app-content/internal/config"
	quizmongo "app-content/internal/infra/mongostore/quiz"
	appredis "app-content/internal/infra/redis"
	quizredis "app-content/internal/infra/redisstore/quiz"
	quizrepo "app-content/internal/repo/quiz"
	quizrouter "app-content/internal/router/quiz"
	quizservice "app-content/internal/service/quiz"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"gorm.io/gorm"
)

// setupQuiz wires the quiz domain onto the shared engine using the process-wide
// MySQL pool, shared Mongo database and shared Redis client.
func setupQuiz(
	ctx context.Context,
	cfg *config.Config,
	engine *gin.Engine,
	db *gorm.DB,
	sharedMongo *mongo.Database,
	redisClient *redis.Client,
) (*domain, error) {
	mongoStore := quizmongo.NewMongoStore(sharedMongo)
	if err := mongoStore.EnsureIndexes(ctx); err != nil {
		slogWarn("[MONGO] ensure quiz indexes failed (continuing)", err)
	}
	redisStore := quizredis.New(redisClient, cfg.Database.Redis.KeyPrefix)

	quizSvc := quizservice.New(quizrepo.New(db, mongoStore.Database()), redisStore)
	quizSvc.Quota = redisStore
	quizSvc.QuotaLimits = map[string]int{"generate": cfg.Quiz.Quota.Generate, "grade": cfg.Quiz.Quota.Grade}
	quizSvc.GenTimeoutBase = time.Duration(cfg.Quiz.Lifecycle.GenerationTimeoutMinutes) * time.Minute
	quizrouter.Register(engine, quizrouter.Deps{Quiz: quizSvc, InternalAPIKey: cfg.Security.InternalAPIKey})

	return &domain{
		name: "quiz",
		ping: func(ctx context.Context) error {
			if db == nil {
				return nil
			}
			if err := db.WithContext(ctx).Exec("select 1").Error; err != nil {
				return err
			}
			if sharedMongo != nil {
				if err := sharedMongo.Client().Ping(ctx, nil); err != nil {
					return err
				}
			}
			return appredis.Ping(ctx, redisClient)
		},
	}, nil
}
