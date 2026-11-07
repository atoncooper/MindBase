package tests

import (
	"strings"
	"testing"
	"time"

	"app-user/internal/infra/metrics"
)

// TestLatencyMetrics pins the percentile histogram contract: route-labelled
// buckets, count/sum, and monotonic approximate quantiles.
func TestLatencyMetrics(t *testing.T) {
	r := metrics.NewRegistry()
	route := metrics.Labels{Service: "auth", Route: "/auth/login"}
	for _, d := range []time.Duration{
		2 * time.Millisecond,
		5 * time.Millisecond,
		80 * time.Millisecond,
		120 * time.Millisecond,
		2 * time.Second,
	} {
		r.Observe(route, d)
	}

	q, ok := r.Quantiles()["auth /auth/login"]
	if !ok {
		t.Fatal("missing quantile row")
	}
	if q.Count != 5 {
		t.Fatalf("count = %d, want 5", q.Count)
	}
	if q.P50 <= 0 || q.P90 < q.P50 || q.P99 < q.P90 || q.P999 < q.P99 {
		t.Fatalf("non-monotonic quantiles: %+v", q)
	}
	if q.P90 < 50 || q.P999 < 1000 {
		t.Fatalf("tail quantiles unexpectedly low: %+v", q)
	}

	text := string(r.Prometheus())
	for _, want := range []string{
		"appuser_http_request_duration_seconds_bucket",
		"service=\"auth\"",
		"route=\"/auth/login\"",
		"le=\"0.001\"",
		"le=\"+Inf\"",
		"appuser_http_request_duration_seconds_count",
		"appuser_http_request_duration_seconds_count{service=\"auth\",route=\"/auth/login\"} 5",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("prometheus output missing %q:\n%s", want, text)
		}
	}
}
