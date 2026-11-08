package bootstrap

import (
	"context"
	"fmt"
	"strings"
	"time"

	"app-content/internal/config"
	boardcache "app-content/internal/infra/cache/board"
	boardrepo "app-content/internal/repo/board"
	boardrouter "app-content/internal/router/board"
	boardservice "app-content/internal/service/board"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"gorm.io/gorm"
)

// setupBoard wires the board domain onto the shared engine. All data-store
// handles (one MySQL pool, one Mongo client/database, one Redis client) are
// owned by Run; the domain never opens or closes a connection.
func setupBoard(
	ctx context.Context,
	cfg *config.Config,
	engine *gin.Engine,
	db *gorm.DB,
	boardMongo *mongo.Database,
	redisClient *redis.Client,
) (*domain, error) {
	var readCache boardcache.CacheStore = boardcache.NoopCache{}
	if redisClient != nil {
		ttl := time.Duration(cfg.Database.Redis.BoardCacheTTLSeconds) * time.Second
		if ttl <= 0 {
			ttl = 300 * time.Second
		}
		readCache = boardcache.NewRedis(redisClient, ttl)
	}

	meta := &boardrepo.BoardRepo{DB: db}
	docs := &boardrepo.MongoDocRepo{Col: boardMongo.Collection("board_documents")}
	boardrouter.Register(engine, boardservice.NewBoardService(meta, docs, readCache), cfg.Security.InternalAPIKey)

	return &domain{
		name: "board",
		ping: func(ctx context.Context) error {
			if db == nil {
				return nil
			}
			if err := db.WithContext(ctx).Exec("select 1").Error; err != nil {
				return err
			}
			if boardMongo != nil {
				return boardMongo.Client().Ping(ctx, nil)
			}
			return nil
		},
	}, nil
}

// boardMongoDatabase resolves the Mongo database used for board documents.
// The historical board database (MindBase) is kept separate from the shared
// note/quiz database (mind_base) to avoid orphaning existing boards.
func boardMongoDatabase(client *mongo.Client, cfg *config.Config) *mongo.Database {
	if client == nil {
		return nil
	}
	name := strings.TrimSpace(cfg.Database.Mongo.BoardDatabase)
	if name == "" {
		name = strings.TrimSpace(cfg.Database.Mongo.Database)
	}
	if name == "" {
		return nil
	}
	return client.Database(name)
}

// warnLegacyBoardDatabase keeps the split visible in logs until boards are
// migrated into the shared Mongo database.
func warnLegacyBoardDatabase(cfg *config.Config) {
	shared := strings.TrimSpace(cfg.Database.Mongo.Database)
	board := cfg.Database.BoardMongoDatabase()
	if board != "" && shared != "" && board != shared {
		slogWarn(fmt.Sprintf("[BOOT] board Mongo database %q differs from shared %q (legacy isolation; migrate board_documents to unify)", board, shared), nil)
	}
}
