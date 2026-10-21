// Health — plain HTTP probe on a secondary port (humans / future gateway
// checks / compose debugging). MySQL down → 503; Neo4j down → degraded
// (still 503: without the graph store this service has no purpose, unlike
// the app-note/app-quiz read paths which degrade gracefully).
//
// The same mux also serves the cloud-doc routing graph (plan 1.0.15, L1) as
// JSON endpoints for app-cloud: gRPC stays the app-ts face (proto contract),
// while app-cloud — a separate Go module whose Docker build context cannot
// import this module's internal kgpb — speaks simple internal JSON here.
// Endpoints are network-internal; when internal_token is configured they
// additionally require a matching X-Internal-Token header (constant time).
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"time"

	"app-kg/internal/db"
	"app-kg/internal/graph"
	"app-kg/internal/neo4jstore"
)

// StartHealth runs the HTTP health endpoint until ctx is cancelled.
func StartHealth(ctx context.Context, addr string, st *neo4jstore.Store, g *graph.Store, internalToken string) *http.Server {
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
	registerCloudDocRoutes(mux, g, internalToken)
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		_ = srv.ListenAndServe()
	}()
	return srv
}

// ── cloud-doc routing endpoints (internal; X-Internal-Token when set) ──

func checkInternalToken(w http.ResponseWriter, r *http.Request, token string) bool {
	if token == "" {
		return true
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Internal-Token")), []byte(token)) == 1 {
		return true
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]any{"detail": "invalid internal token"})
	return false
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func registerCloudDocRoutes(mux *http.ServeMux, g *graph.Store, token string) {
	if g == nil {
		return
	}
	mux.HandleFunc("/internal/kg/cloud-doc/upsert", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !checkInternalToken(w, r, token) {
			return
		}
		var req struct {
			UID         int64    `json:"uid"`
			UploadUUID  string   `json:"upload_uuid"`
			Title       string   `json:"title"`
			ContentHash string   `json:"content_hash"`
			Topics      []string `json:"topics"`
			Entities    []string `json:"entities"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.UploadUUID == "" || req.UID <= 0 {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": "invalid body"})
			return
		}
		if err := g.UpsertCloudDocGraph(r.Context(), graph.CloudDocGraph{
			UID: req.UID, UploadUUID: req.UploadUUID, Title: req.Title,
			ContentHash: req.ContentHash, Topics: req.Topics, Entities: req.Entities,
		}); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"detail": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("/internal/kg/cloud-doc/delete", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !checkInternalToken(w, r, token) {
			return
		}
		var req struct {
			UID        int64  `json:"uid"`
			UploadUUID string `json:"upload_uuid"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.UploadUUID == "" || req.UID <= 0 {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": "invalid body"})
			return
		}
		if err := g.DeleteCloudDocGraph(r.Context(), req.UID, req.UploadUUID); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"detail": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("/internal/kg/cloud-doc/match", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !checkInternalToken(w, r, token) {
			return
		}
		var req struct {
			UID      int64    `json:"uid"`
			Keywords []string `json:"keywords"`
			Limit    int      `json:"limit"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.UID <= 0 {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": "invalid body"})
			return
		}
		if req.Limit <= 0 {
			req.Limit = 10
		}
		matches, err := g.MatchCloudDocs(r.Context(), req.UID, req.Keywords, req.Limit)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"detail": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"matches": matches})
	})
}
