// Package http is app-kg's operational HTTP face: the /health probe plus the
// internal cloud-doc routing JSON endpoints consumed by app-cloud. Pure
// transport — decode the payload, call the service, write the status code; no
// SQL/Cypher here.
package http

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"app-kg/internal/service"
)

// Pinger is the connectivity face of a store (satisfied by infra/mysql.DB and
// infra/neo4j.Store) — the health probe needs no driver details.
type Pinger interface {
	Ping(ctx context.Context) error
}

// Deps wires the health probes and the cloud-doc service.
type Deps struct {
	MySQL    Pinger
	Neo4j    Pinger
	CloudDoc *service.CloudDocService
	// InternalToken guards the cloud-doc routing endpoints. Empty = allow
	// (network-internal posture, same as the probe itself); set to require a
	// matching X-Internal-Token header.
	InternalToken string
}

// StartHealth runs the HTTP endpoint on addr until the process exits.
func StartHealth(ctx context.Context, addr string, d Deps) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		body := map[string]any{"status": "ok", "service": "app-kg"}
		code := http.StatusOK
		if d.Neo4j != nil {
			if err := d.Neo4j.Ping(r.Context()); err != nil {
				body["status"] = "degraded"
				body["neo4j"] = "down"
				code = http.StatusServiceUnavailable
			}
		}
		if d.MySQL != nil {
			if err := d.MySQL.Ping(r.Context()); err != nil {
				body["status"] = "degraded"
				body["mysql"] = "down"
				code = http.StatusServiceUnavailable
			}
		}
		writeJSON(w, code, body)
	})
	registerCloudDocRoutes(mux, d)
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		_ = srv.ListenAndServe()
	}()
	return srv
}

// ── cloud-doc routing endpoints (internal; X-Internal-Token when set) ──

func registerCloudDocRoutes(mux *http.ServeMux, d Deps) {
	if d.CloudDoc == nil {
		return
	}
	mux.HandleFunc("/internal/kg/cloud-doc/upsert", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !checkInternalToken(w, r, d.InternalToken) {
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
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": "invalid body"})
			return
		}
		if err := d.CloudDoc.Upsert(r.Context(), service.CloudDocGraph{
			UID: req.UID, UploadUUID: req.UploadUUID, Title: req.Title,
			ContentHash: req.ContentHash, Topics: req.Topics, Entities: req.Entities,
		}); err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("/internal/kg/cloud-doc/delete", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !checkInternalToken(w, r, d.InternalToken) {
			return
		}
		var req struct {
			UID        int64  `json:"uid"`
			UploadUUID string `json:"upload_uuid"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": "invalid body"})
			return
		}
		if err := d.CloudDoc.Delete(r.Context(), req.UID, req.UploadUUID); err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("/internal/kg/cloud-doc/match", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !checkInternalToken(w, r, d.InternalToken) {
			return
		}
		var req struct {
			UID      int64    `json:"uid"`
			Keywords []string `json:"keywords"`
			Limit    int      `json:"limit"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": "invalid body"})
			return
		}
		matches, err := d.CloudDoc.Match(r.Context(), req.UID, req.Keywords, req.Limit)
		if err != nil {
			writeServiceError(w, err)
			return
		}
		if matches == nil {
			matches = []service.CloudDocMatch{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"matches": matches})
	})
}

func checkInternalToken(w http.ResponseWriter, r *http.Request, token string) bool {
	if token == "" {
		return true
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Internal-Token")), []byte(token)) == 1 {
		return true
	}
	writeJSON(w, http.StatusUnauthorized, map[string]any{"detail": "invalid internal token"})
	return false
}

// writeServiceError maps domain validation to 422 ("invalid body", the
// established app-cloud contract) and everything else to 500.
func writeServiceError(w http.ResponseWriter, err error) {
	var inv *service.InvalidArgumentError
	if errors.As(err, &inv) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": "invalid body"})
		return
	}
	writeJSON(w, http.StatusInternalServerError, map[string]any{"detail": err.Error()})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
