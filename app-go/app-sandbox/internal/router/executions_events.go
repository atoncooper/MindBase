package router

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"app-sandbox/internal/service"

	"github.com/gin-gonic/gin"
)

// executionEvents streams SSE frames: status / stdout / stderr / artifact / done.
// The frame payloads are the service event data (the SSE wire is not part of the
// JSON DTO surface).
func executionEvents(c *gin.Context, d Deps) {
	uid := currentUID(c)
	history, events, cancel, err := d.Executions.Events(c.Request.Context(), uid, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	defer cancel()

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		apiErr(c, http.StatusInternalServerError, "SSE 不受支持")
		return
	}
	writeEvent := func(ev service.Event) bool {
		payload, merr := json.Marshal(ev.Data)
		if merr != nil {
			return true
		}
		if _, werr := fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", ev.Type, payload); werr != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	for _, ev := range history {
		if !writeEvent(ev) {
			return
		}
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case <-heartbeat.C:
			if _, err := fmt.Fprint(c.Writer, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case ev, open := <-events:
			if !open {
				return
			}
			if !writeEvent(ev) {
				return
			}
		}
	}
}
