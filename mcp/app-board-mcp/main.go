// app-board-mcp: MCP server exposing the app-board mind-map/whiteboard store
// to agents. Upstream calls go through the APISIX key-auth route
// /internal/board/* with the configured apikey + acting X-Uid.
//
// Transports: stdio (default, for local MCP hosts) and streamable-http
// (container deployment; the MCP endpoint is /mcp, plus a plain /health).
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"app-board-mcp/internal/certs"
	"app-board-mcp/internal/config"
	"app-board-mcp/internal/handlers"
	"app-board-mcp/internal/logger"
	"app-board-mcp/internal/serve"
	"app-board-mcp/internal/upstream"

	"github.com/mark3labs/mcp-go/server"
	"golang.org/x/time/rate"
)

const (
	serverName    = "app-board-mcp"
	serverVersion = "0.1.0"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	// Flags override env so the container entrypoint can pin the transport
	// without a dedicated env key.
	var (
		transport = flag.String("transport", "", "MCP transport: stdio | http (overrides BOARDMCP__SERVER__TRANSPORT)")
		httpAddr  = flag.String("http-addr", "", "listen address for the http transport (overrides BOARDMCP__SERVER__HTTP_ADDR)")
	)
	flag.Parse()

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if *transport != "" {
		cfg.Server.Transport = *transport
	}
	if *httpAddr != "" {
		cfg.Server.HTTPAddr = *httpAddr
	}

	// Logging first: everything after this logs through slog.Default().
	// stdout is the MCP JSON-RPC channel in stdio mode — refuse stdout sinks
	// there even if misconfigured.
	if cfg.Server.Transport == config.TransportStdio && logger.GuardStdioOutput(cfg.Log.Output) {
		fmt.Fprintf(os.Stderr, "warning: BOARDMCP__LOG__OUTPUT=%s is unsafe for the stdio transport (stdout is the protocol channel); forcing stderr\n", cfg.Log.Output)
		cfg.Log.Output = "stderr"
	}
	slog.SetDefault(logger.New(cfg.Log.ToOptions()))
	cfg.WarnMissing(slog.Default())
	slog.Info("[BOARDMCP] starting",
		"transport", cfg.Server.Transport, "upstream", cfg.Upstream.BaseURL)

	client := upstream.NewClient(cfg.Upstream.BaseURL, cfg.Upstream.APIKey, cfg.Upstream.UID)
	// Hooks carry the dynamic resources/list injection (request-time upstream
	// fan-out); the registration set itself never changes at runtime.
	hooks := &server.Hooks{}
	mcpServer := server.NewMCPServer(
		serverName,
		serverVersion,
		server.WithRecovery(),
		// subscribe off (no change feed from app-board); listChanged off
		// (static registration set, the list is refreshed per-request via hooks).
		server.WithResourceCapabilities(false, false),
		server.WithHooks(hooks),
	)
	registry := handlers.New(client, cfg)
	registry.Register(mcpServer)
	registry.RegisterResources(mcpServer, hooks)
	registry.RegisterPrompts(mcpServer)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch cfg.Server.Transport {
	case config.TransportStdio:
		return server.NewStdioServer(mcpServer).Listen(ctx, os.Stdin, os.Stdout)

	case config.TransportHTTP:
		return serveHTTP(ctx, cfg, mcpServer)

	default:
		return fmt.Errorf("unknown transport %q (must be stdio or http)", cfg.Server.Transport)
	}
}

// serveHTTP mounts the streamable-http MCP endpoint and a plain /health probe
// behind one mux, then blocks until the context is canceled. /mcp goes through
// the hardening chain (rate limit → auth → in-flight cap → body cap); /health
// stays an unauthenticated probe. Every request passes request-id injection
// and the access log.
func serveHTTP(ctx context.Context, cfg *config.Config, mcpServer *server.MCPServer) error {
	limiter := rate.NewLimiter(rate.Limit(cfg.Server.RateLimitRPS), cfg.Server.RateLimitBurst)
	mcpChain := serve.Chain(
		serve.RateLimit(limiter),
		serve.Auth(cfg.Server.AuthToken, cfg.Server.ServiceAPIKey, cfg.Server.AllowedOrigins),
		serve.Inflight(cfg.Server.MaxInflight),
		serve.BodyCap(cfg.Server.MaxBodyBytes),
	)

	mux := http.NewServeMux()
	mux.Handle("/mcp", mcpChain(server.NewStreamableHTTPServer(mcpServer)))
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"healthy","service":"app-board-mcp"}`))
	})

	// TLS: resolved before binding so a broken certificate fails fast at
	// startup rather than on the first handshake. Auto mode generates a dev
	// CA + leaf into CertDir and keeps them rotated; stdio never reaches here.
	if cfg.TLSEnabled() {
		rot, err := certs.NewRotator(cfg.Server.TLS.CertFile, cfg.Server.TLS.KeyFile, cfg.Server.TLS.CertDir)
		if err != nil {
			return fmt.Errorf("resolve tls certificate: %w", err)
		}
		rot.Summary()
		rotStart := make(chan struct{})
		rot.Start(rotStart)
		defer close(rotStart)
		srv := &http.Server{
			Addr: cfg.Server.HTTPAddr,
			// No ReadTimeout/WriteTimeout: streamable-http holds long-lived SSE
			// responses for MCP sessions; only header reads are bounded.
			Handler:           serve.Chain(serve.RequestID(), serve.AccessLog())(mux),
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       120 * time.Second,
			TLSConfig: &tls.Config{
				MinVersion:     tls.VersionTLS12,
				GetCertificate: rot.GetCertificate,
			},
		}
		return runHTTPServer(ctx, cfg, srv, true)
	}

	srv := &http.Server{
		Addr: cfg.Server.HTTPAddr,
		// No ReadTimeout/WriteTimeout: streamable-http holds long-lived SSE
		// responses for MCP sessions; only header reads are bounded.
		Handler:           serve.Chain(serve.RequestID(), serve.AccessLog())(mux),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	return runHTTPServer(ctx, cfg, srv, false)
}

// runHTTPServer blocks serving srv until ctx is canceled, then shuts down
// gracefully. withTLS selects ListenAndServeTLS (cert via srv.TLSConfig).
func runHTTPServer(ctx context.Context, cfg *config.Config, srv *http.Server, withTLS bool) error {
	errCh := make(chan error, 1)
	go func() {
		// http.ErrServerClosed signals the intended shutdown path, not a failure.
		var err error
		if withTLS {
			slog.Info("[BOARDMCP] serving MCP over streamable-https",
				"addr", cfg.Server.HTTPAddr, "endpoint", "/mcp", "upstream", cfg.Upstream.BaseURL,
				"auth", "bearer", "rate_limit_rps", cfg.Server.RateLimitRPS, "max_inflight", cfg.Server.MaxInflight)
			err = srv.ListenAndServeTLS("", "")
		} else {
			slog.Info("[BOARDMCP] serving MCP over streamable-http",
				"addr", cfg.Server.HTTPAddr, "endpoint", "/mcp", "upstream", cfg.Upstream.BaseURL,
				"auth", "bearer", "rate_limit_rps", cfg.Server.RateLimitRPS, "max_inflight", cfg.Server.MaxInflight,
				"tls", "disabled (loopback posture)")
			err = srv.ListenAndServe()
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	slog.Info("[BOARDMCP] stopped")
	return nil
}
