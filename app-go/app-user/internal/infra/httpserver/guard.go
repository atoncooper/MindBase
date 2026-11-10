// Package httpserver contains listener-level guards that sit in front of the
// three Gin engines: request/connection limits, keep-alive caps and response
// compression. Route-level concerns stay in router middleware.
package httpserver

import (
	"compress/gzip"
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/andybalholm/brotli"
)

type Config struct {
	MaxConnections       int
	MaxConcurrent        int
	MaxConcurrentPerIP   int
	Compression          string // none|gzip|br|both
	KeepAliveMaxRequests int
}

type connCounterKey struct{}

// ConnContext attaches a per-connection request counter used by keepalive caps.
func ConnContext(ctx context.Context, _ net.Conn) context.Context {
	return context.WithValue(ctx, connCounterKey{}, &atomic.Int64{})
}

type guard struct {
	next      http.Handler
	cfg       Config
	global    chan struct{}
	mu        sync.Mutex
	perIP     map[string]int
	perIPMax  int
	keepAlive int
}

// Wrap applies request limits + compression. MaxConnections is enforced as a
// hard concurrent-request cap (listener connections are short-lived here);
// MaxConcurrent is a softer global cap when both are configured.
func Wrap(next http.Handler, cfg Config) http.Handler {
	g := &guard{next: next, cfg: cfg, perIP: map[string]int{}, perIPMax: cfg.MaxConcurrentPerIP, keepAlive: cfg.KeepAliveMaxRequests}
	limit := cfg.MaxConnections
	if cfg.MaxConcurrent > 0 && (limit == 0 || cfg.MaxConcurrent < limit) {
		limit = cfg.MaxConcurrent
	}
	if limit > 0 {
		g.global = make(chan struct{}, limit)
	}
	return g
}

func (g *guard) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if g.global != nil {
		select {
		case g.global <- struct{}{}:
			defer func() { <-g.global }()
		default:
			http.Error(w, "服务繁忙，请稍后重试", http.StatusServiceUnavailable)
			return
		}
	}
	ip := clientIP(r)
	if g.perIPMax > 0 {
		g.mu.Lock()
		if g.perIP[ip] >= g.perIPMax {
			g.mu.Unlock()
			http.Error(w, "请求过于频繁，请稍后重试", http.StatusTooManyRequests)
			return
		}
		g.perIP[ip]++
		g.mu.Unlock()
		defer func() {
			g.mu.Lock()
			if g.perIP[ip] <= 1 {
				delete(g.perIP, ip)
			} else {
				g.perIP[ip]--
			}
			g.mu.Unlock()
		}()
	}
	if g.keepAlive > 0 {
		if counter, ok := r.Context().Value(connCounterKey{}).(*atomic.Int64); ok {
			if counter.Add(1) >= int64(g.keepAlive) {
				w.Header().Set("Connection", "close")
			}
		}
	}
	if g.cfg.Compression != "" && g.cfg.Compression != "none" {
		cw := &compressWriter{ResponseWriter: w, req: r, mode: g.cfg.Compression}
		g.next.ServeHTTP(cw, r)
		_ = cw.Close()
		return
	}
	g.next.ServeHTTP(w, r)
}

func clientIP(r *http.Request) string {
	// Behind nginx/APISIX the socket peer is the gateway; nginx supplies the
	// real client in X-Forwarded-For. app-user binds loopback/private only, so
	// the header is not reachable from an untrusted direct client.
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		if first := strings.TrimSpace(strings.Split(xff, ",")[0]); first != "" {
			return first
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

type compressWriter struct {
	http.ResponseWriter
	req     *http.Request
	mode    string
	writer  io.WriteCloser
	started bool
}

func (w *compressWriter) WriteHeader(code int) {
	if w.started {
		return
	}
	w.started = true
	encoding := chooseEncoding(w.req.Header.Get("Accept-Encoding"), w.mode)
	if encoding != "" && code >= 200 && code != http.StatusNoContent && code != http.StatusNotModified {
		w.Header().Set("Content-Encoding", encoding)
		w.Header().Del("Content-Length")
		w.Header().Add("Vary", "Accept-Encoding")
		switch encoding {
		case "br":
			w.writer = brotli.NewWriter(w.ResponseWriter)
		default:
			w.writer = gzip.NewWriter(w.ResponseWriter)
		}
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *compressWriter) Write(p []byte) (int, error) {
	if !w.started {
		w.WriteHeader(http.StatusOK)
	}
	if w.writer != nil {
		return w.writer.Write(p)
	}
	return w.ResponseWriter.Write(p)
}

func (w *compressWriter) Flush() {
	if w.writer != nil {
		if f, ok := w.writer.(interface{ Flush() error }); ok {
			_ = f.Flush()
		}
	}
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func chooseEncoding(accept, mode string) string {
	accept = strings.ToLower(accept)
	allowBR := mode == "br" || mode == "both"
	allowGzip := mode == "gzip" || mode == "both"
	if allowBR && strings.Contains(accept, "br") {
		return "br"
	}
	if allowGzip && strings.Contains(accept, "gzip") {
		return "gzip"
	}
	return ""
}

// Flush closes the compressor before the underlying response finishes.
func (w *compressWriter) Close() error {
	if w.writer != nil {
		return w.writer.Close()
	}
	return nil
}
