// app-kg entrypoint: load config, init MySQL + Neo4j, ensure constraints,
// start the gRPC server (kg.v1.KgGraph) + HTTP health probe, graceful
// shutdown.
//
// KG storage service: the complete Neo4j data access for the knowledge
// graph plus video.kg_status/kg_version bookkeeping and favorite-folder
// scope resolution. The AI side (extraction / retrieval / build
// orchestration) lives in app-ts. Run from project root:
// go run ./app-go/app-kg
package main

import (
	"context"
	_ "embed" // embed default.yaml via //go:embed below
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "time/tzdata" // embed IANA tz database so Asia/Shanghai works in distroless

	"app-kg/internal/config"
	"app-kg/internal/db"
	"app-kg/internal/graph"
	"app-kg/internal/kgpb"
	"app-kg/internal/logger"
	"app-kg/internal/neo4jstore"
	"app-kg/internal/server"

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"
)

//go:embed default.yaml
var defaultYAML []byte

func main() {
	cfg, err := config.Load(defaultYAML)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		os.Exit(1)
	}

	logLevel := cfg.Log.Level
	if logLevel == "" {
		logLevel = "info"
	}
	if cfg.App.Debug && logLevel == "info" {
		logLevel = "debug"
	}
	logger.Init(logger.Options{
		Level:  logLevel,
		Format: cfg.Log.Format,
		Output: cfg.Log.Output,
		File: logger.FileOptions{
			Path:       cfg.Log.File.Path,
			MaxSize:    cfg.Log.File.MaxSize,
			MaxBackups: cfg.Log.File.MaxBackups,
			MaxAge:     cfg.Log.File.MaxAge,
			Compress:   cfg.Log.File.Compress,
		},
	})
	slog.Info("app-kg starting", "grpc_port", cfg.Server.GrpcPort,
		"health_port", cfg.Server.HealthPort, "tz", cfg.Timezone)

	if err := config.Validate(cfg); err != nil {
		slog.Error("config validation failed", "err", err)
		os.Exit(1)
	}

	// MySQL — shared bilirag database (read-mostly; writes ONLY the
	// video.kg_status/kg_version columns).
	if err := db.Init(cfg.RDBMS.URL, cfg.RDBMS.MaxOpenConns, cfg.RDBMS.MaxIdleConns,
		cfg.RDBMS.ConnMaxLifetime, cfg.App.Debug); err != nil {
		slog.Error("init mysql failed", "err", err)
		os.Exit(1)
	}
	defer db.Close()

	// Neo4j — the graph store this service owns.
	ctx := context.Background()
	st, err := neo4jstore.Connect(ctx, cfg.Neo4j.URI, cfg.Neo4j.Username,
		cfg.Neo4j.Password, cfg.Neo4j.Database)
	if err != nil {
		slog.Error("connect neo4j failed", "err", err)
		os.Exit(1)
	}
	defer st.Close(ctx)
	if err := st.EnsureConstraints(ctx); err != nil {
		slog.Warn("[NEO4J] ensure constraints failed (continuing — may already exist)", "err", err)
	}

	// Business timezone.
	if loc, lerr := time.LoadLocation(cfg.Timezone); lerr == nil {
		time.Local = loc
	} else {
		slog.Warn("invalid timezone, falling back to UTC", "tz", cfg.Timezone, "err", lerr)
	}

	// gRPC server: interceptors + health + reflection (grpcurl debugging).
	lis, err := net.Listen("tcp", fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.GrpcPort))
	if err != nil {
		slog.Error("listen failed", "err", err)
		os.Exit(1)
	}
	grpcServer := grpc.NewServer(
		grpc.ChainUnaryInterceptor(server.Interceptor()),
	)
	kgpb.RegisterKgGraphServer(grpcServer, server.New(server.Deps{
		Graph: graph.New(st),
	}))
	healthSrv := health.NewServer()
	healthSrv.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)
	healthpb.RegisterHealthServer(grpcServer, healthSrv)
	reflection.Register(grpcServer)

	go func() {
		slog.Info("app-kg listening", "addr", lis.Addr().String())
		if err := grpcServer.Serve(lis); err != nil {
			slog.Error("grpc server stopped", "err", err)
			os.Exit(1)
		}
	}()

	healthAddr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.HealthPort)
	healthHTTP := server.StartHealth(ctx, healthAddr, st)
	slog.Info("app-kg health endpoint", "addr", healthAddr)

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	slog.Info("shutting down")
	healthSrv.SetServingStatus("", healthpb.HealthCheckResponse_NOT_SERVING)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = healthHTTP.Shutdown(shutdownCtx)
	stopped := make(chan struct{})
	go func() {
		grpcServer.GracefulStop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(10 * time.Second):
		grpcServer.Stop()
	}
	slog.Info("app-kg stopped")
}
