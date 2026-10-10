// Health — plain HTTP probe on a secondary port (humans / future gateway
// checks / compose debugging). MySQL down → 503; Neo4j down → degraded
// (still 503: without the graph store this service has no purpose, unlike
// the app-note/app-quiz read paths which degrade gracefully).
package server

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"app-kg/internal/db"
	"app-kg/internal/neo4jstore"
)

// StartHealth runs the HTTP health endpoint until ctx is cancelled.
func StartHealth(ctx context.Context, addr string, st *neo4jstore.Store) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		body := map[string]any{"status": "ok", "service": "app-kg"}
		code := http.StatusOK
		if err := st.Ping(r.Context()); err != nil {
			body["status"] = "degraded"
			body["neo4j"] = "down"
			code = http.StatusServiceUnavailable
		}
		if db.DB != nil {
			pingCtx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			if err := db.DB.WithContext(pingCtx).Exec("select 1").Error; err != nil {
				body["status"] = "degraded"
				body["mysql"] = "down"
				code = http.StatusServiceUnavailable
			}
			cancel()
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(body)
	})
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		_ = srv.ListenAndServe()
	}()
	return srv
}
