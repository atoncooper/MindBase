// Package metrics is a dependency-free latency histogram registry. It exists
// because the service previously emitted only per-request access logs: there
// was no way to compute p90/p99/p999 over a window, nor to alert on tails.
//
// Two views are exposed from the auth listener:
//   - /metrics: Prometheus text exposition (histogram buckets), so a real
//     scraper can use histogram_quantile() over its own window;
//   - /debug/latency: an approximate in-process percentile snapshot (useful
//     for local checks; Prometheus remains the source of truth).
//
// Buckets cover 1ms..10s, which spans cache hits, MySQL fallbacks, bcrypt logins
// and slow B站/ASR paths. Quantiles are interpolated within a bucket; p999 is
// only meaningful when the window has enough samples, so it must be read
// together with the count.
package metrics

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultBounds is the latency bucket set in seconds.
var DefaultBounds = []float64{
	0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
}

// Labels identify one histogram stream. Route is the Gin route pattern (not
// the raw path) to keep cardinality bounded.
type Labels struct {
	Service string
	Route   string
}

type histogram struct {
	bounds  []float64
	buckets []uint64 // counts for each finite upper bound
	count   uint64
	sum     uint64 // nanoseconds
}

// QuantileSet is the /debug/latency row (approximate, milliseconds).
type QuantileSet struct {
	Count uint64  `json:"count"`
	P50   float64 `json:"p50_ms"`
	P55   float64 `json:"p55_ms"`
	P90   float64 `json:"p90_ms"`
	P95   float64 `json:"p95_ms"`
	P99   float64 `json:"p99_ms"`
	P999  float64 `json:"p999_ms"`
	Max   float64 `json:"max_ms"`
}

// Registry holds one histogram per service+route.
type Registry struct {
	mu        sync.Mutex
	hist      map[Labels]*histogram
	maxRoutes int
}

// Default is the process-wide registry shared by all three engines.
var Default = NewRegistry()

// NewRegistry builds an empty registry.
func NewRegistry() *Registry {
	return &Registry{hist: make(map[Labels]*histogram), maxRoutes: 500}
}

func newHistogram() *histogram {
	return &histogram{bounds: append([]float64(nil), DefaultBounds...), buckets: make([]uint64, len(DefaultBounds))}
}

// Observe records one request duration.
func (r *Registry) Observe(l Labels, d time.Duration) {
	if d < 0 {
		d = 0
	}
	sec := d.Seconds()
	r.mu.Lock()
	h := r.hist[l]
	if h == nil {
		if len(r.hist) >= r.maxRoutes {
			r.mu.Unlock()
			return
		}
		h = newHistogram()
		r.hist[l] = h
	}
	h.count++
	h.sum += uint64(d.Nanoseconds())
	// Histogram buckets are mutually exclusive here; exposition converts to
	// cumulative counts.
	for i, b := range h.bounds {
		if sec <= b {
			h.buckets[i]++
			r.mu.Unlock()
			return
		}
	}
	r.mu.Unlock()
}

// snapshot returns a consistent copy for rendering.
func (r *Registry) snapshot() map[Labels]*histogram {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[Labels]*histogram, len(r.hist))
	for k, v := range r.hist {
		cp := &histogram{
			bounds:  append([]float64(nil), v.bounds...),
			buckets: append([]uint64(nil), v.buckets...),
			count:   v.count,
			sum:     v.sum,
		}
		out[k] = cp
	}
	return out
}

// Prometheus renders the default registry in Prometheus text format.
func (r *Registry) Prometheus() []byte {
	return r.prometheus(r.snapshot())
}

func (r *Registry) prometheus(snap map[Labels]*histogram) []byte {
	keys := make([]Labels, 0, len(snap))
	for k := range snap {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].Service != keys[j].Service {
			return keys[i].Service < keys[j].Service
		}
		return keys[i].Route < keys[j].Route
	})

	var b strings.Builder
	b.WriteString("# HELP appuser_http_request_duration_seconds HTTP request latency by service and Gin route.\n")
	b.WriteString("# TYPE appuser_http_request_duration_seconds histogram\n")
	for _, k := range keys {
		h := snap[k]
		var cum uint64
		base := fmt.Sprintf("appuser_http_request_duration_seconds_bucket{service=%s,route=%s,le=",
			quote(k.Service), quote(k.Route))
		for i, bnd := range h.bounds {
			cum += h.buckets[i]
			b.WriteString(base)
			b.WriteString(quote(strconv.FormatFloat(bnd, 'f', -1, 64)))
			b.WriteString("} ")
			b.WriteString(strconv.FormatUint(cum, 10))
			b.WriteString("\n")
		}
		b.WriteString(fmt.Sprintf("appuser_http_request_duration_seconds_bucket{service=%s,route=%s,le=\"+Inf\"} %d\n",
			quote(k.Service), quote(k.Route), h.count))
		b.WriteString(fmt.Sprintf("appuser_http_request_duration_seconds_sum{service=%s,route=%s} %g\n",
			quote(k.Service), quote(k.Route), float64(h.sum)/float64(time.Second)))
		b.WriteString(fmt.Sprintf("appuser_http_request_duration_seconds_count{service=%s,route=%s} %d\n",
			quote(k.Service), quote(k.Route), h.count))
	}
	return []byte(b.String())
}

func quote(s string) string { return strconv.Quote(s) }

// Quantiles returns an approximate percentile snapshot keyed by
// "service route" (milliseconds). It is intended for /debug/latency; a real
// monitoring window should use the Prometheus histogram and
// histogram_quantile().
func (r *Registry) Quantiles() map[string]QuantileSet {
	snap := r.snapshot()
	out := make(map[string]QuantileSet, len(snap))
	for k, h := range snap {
		out[k.Service+" "+k.Route] = QuantileSet{
			Count: h.count,
			P50:   h.quantile(0.50),
			P55:   h.quantile(0.55),
			P90:   h.quantile(0.90),
			P95:   h.quantile(0.95),
			P99:   h.quantile(0.99),
			P999:  h.quantile(0.999),
			Max:   h.maxMS(),
		}
	}
	return out
}

// quantile interpolates within the bucket containing rank q*count.
func (h *histogram) quantile(q float64) float64 {
	if h.count == 0 {
		return 0
	}
	rank := q * float64(h.count)
	var cum uint64
	lower := 0.0
	for i, upper := range h.bounds {
		cum += h.buckets[i]
		if rank <= float64(cum) {
			n := float64(h.buckets[i])
			if n <= 0 {
				return upper * 1000
			}
			prev := float64(cum - h.buckets[i])
			frac := (rank - prev) / n
			return (lower + (upper-lower)*frac) * 1000
		}
		lower = upper
	}
	// Tail above the highest finite bucket: report the bucket ceiling; callers
	// must read Count to judge significance.
	return h.bounds[len(h.bounds)-1] * 1000
}

func (h *histogram) maxMS() float64 {
	// The histogram does not track per-request max; the highest non-empty
	// bucket is a safe upper approximation for this debug view.
	if h.count == 0 {
		return 0
	}
	for i := len(h.buckets) - 1; i >= 0; i-- {
		if h.buckets[i] > 0 {
			return h.bounds[i] * 1000
		}
	}
	return 0
}
