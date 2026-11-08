// Package metrics is a small dependency-free Prometheus text exporter:
// per-route HTTP counters plus request-duration sums, uptime and build info.
// Route labels use Gin's FullPath so cardinality is bounded by the route table.
package metrics

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type series struct {
	method   string
	route    string
	status   string
	class    string
	count    uint64
	duration float64
}

// Registry collects HTTP metrics.
type Registry struct {
	mu      sync.Mutex
	started time.Time
	counts  map[string]*series // method|route|status
}

// New creates a registry.
func New() *Registry {
	return &Registry{started: time.Now(), counts: map[string]*series{}}
}

// Middleware records one counter + duration per request.
func (r *Registry) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		status := c.Writer.Status()
		route := c.FullPath()
		if route == "" {
			route = "unmatched"
		}
		key := c.Request.Method + "|" + route + "|" + strconv.Itoa(status)
		r.mu.Lock()
		s, ok := r.counts[key]
		if !ok {
			s = &series{
				method: c.Request.Method,
				route:  route,
				status: strconv.Itoa(status),
				class:  strconv.Itoa(status/100) + "xx",
			}
			r.counts[key] = s
		}
		s.count++
		s.duration += time.Since(start).Seconds()
		r.mu.Unlock()
	}
}

// Handler renders Prometheus text format.
func (r *Registry) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		r.mu.Lock()
		keys := make([]string, 0, len(r.counts))
		for k := range r.counts {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var b strings.Builder
		b.WriteString("# HELP app_content_http_requests_total HTTP requests by method, route and status.\n")
		b.WriteString("# TYPE app_content_http_requests_total counter\n")
		for _, k := range keys {
			s := r.counts[k]
			fmt.Fprintf(&b, "app_content_http_requests_total{method=%q,route=%q,status=%q,class=%q} %d\n",
				s.method, s.route, s.status, s.class, s.count)
		}
		b.WriteString("# HELP app_content_http_request_duration_seconds_sum Total request duration.\n")
		b.WriteString("# TYPE app_content_http_request_duration_seconds_sum counter\n")
		for _, k := range keys {
			s := r.counts[k]
			fmt.Fprintf(&b, "app_content_http_request_duration_seconds_sum{method=%q,route=%q,status=%q} %f\n",
				s.method, s.route, s.status, s.duration)
		}
		b.WriteString("# HELP app_content_http_request_duration_seconds_count Request count for duration.\n")
		b.WriteString("# TYPE app_content_http_request_duration_seconds_count counter\n")
		for _, k := range keys {
			s := r.counts[k]
			fmt.Fprintf(&b, "app_content_http_request_duration_seconds_count{method=%q,route=%q,status=%q} %d\n",
				s.method, s.route, s.status, s.count)
		}
		r.mu.Unlock()
		fmt.Fprintf(&b, "# HELP app_content_uptime_seconds Process uptime.\n# TYPE app_content_uptime_seconds gauge\napp_content_uptime_seconds %d\n", int64(time.Since(r.started).Seconds()))
		fmt.Fprintf(&b, "# HELP app_content_build_info Build information.\n# TYPE app_content_build_info gauge\napp_content_build_info{service=%q} 1\n", "app-content")
		_, _ = w.Write([]byte(b.String()))
	}
}
