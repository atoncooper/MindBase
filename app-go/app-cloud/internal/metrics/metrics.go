// Package metrics — Prometheus instrumentation for app-cloud.
//
// Scope is deliberately small: the signals an operator actually needs to
// reason about a multi-replica drive:
//
//   - HTTP golden signals (per route TEMPLATE, never per raw path — uuid
//     path params must not create label cardinality)
//   - upload completion outcomes (the quota-bypass guard is a security
//     control — its rejections must be visible)
//   - quota reserve outcomes (oversell protection + recheck degradation)
//   - vectorize pipeline queue/worker health (the durable outbox)
//   - background-job lease contention (multi-replica sweep behaviour)
//
// The /metrics endpoint is registered on the same Gin engine; nginx does not
// route it, so it stays cluster-internal.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"net/http"
)

var (
	HTTPRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "appcloud_http_requests_total",
		Help: "HTTP requests by method, route template and status code.",
	}, []string{"method", "route", "status"})
	HTTPDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "appcloud_http_request_duration_seconds",
		Help:    "HTTP request latency by route template.",
		Buckets: prometheus.DefBuckets,
	}, []string{"method", "route"})

	UploadComplete = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "appcloud_upload_complete_total",
		Help: "Multipart completions by outcome. size_mismatch = quota-bypass guard rejection; stat_error = fail-closed verification failure.",
	}, []string{"result"}) // ok | size_mismatch | stat_error | db_error

	SummaryTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "appcloud_summary_total",
		Help: "L1 document-summary stage outcomes (best-effort — errors never block vectorization).",
	}, []string{"result"}) // ok | error | skipped

	KgWriteTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "appcloud_kg_write_total",
		Help: "L1 routing-graph writes to app-kg by outcome (best-effort — drift self-heals on the next upsert).",
	}, []string{"result"}) // ok | error | skipped

	QuotaReserve = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "appcloud_quota_reserve_total",
		Help: "Upload-init quota reservations by outcome.",
	}, []string{"result"}) // ok | exceeded | recheck_rejected | legacy_ok | legacy_exceeded
	QuotaRecheckSkipped = promauto.NewCounter(prometheus.CounterOpts{
		Name: "appcloud_quota_recheck_skipped_total",
		Help: "Post-reserve rechecks skipped because the usage query failed (availability-first degradation).",
	})

	VectorizeRuns = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "appcloud_vectorize_runs_total",
		Help: "Vectorize pipeline runs by terminal outcome.",
	}, []string{"result"}) // done | failed | panic
	PipelineClaimed = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "appcloud_pipeline_claimed",
		Help: "Outbox tasks currently claimed by this replica.",
	})
	PipelineRequeued = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "appcloud_pipeline_requeued_total",
		Help: "Outbox tasks requeued by the janitor: stale = crashed claim recovery, failed_retry = bounded retry of a terminal-failed run.",
	}, []string{"reason"}) // stale | failed_retry
	QueueDepth = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "appcloud_queue_depth",
		Help: "Vectorize outbox rows by state (pending = backlog, processing = in-flight) — the peak-shaving buffer in numbers.",
	}, []string{"state"}) // pending | processing

	JoblockAcquire = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "appcloud_joblock_acquire_total",
		Help: "Background-job lease attempts by job and outcome (held = another replica owns the tick).",
	}, []string{"job", "result"}) // acquired | held | error
)

// Handler serves the Prometheus exposition format (default registry:
// these metrics + go/process collectors).
func Handler() http.Handler { return promhttp.Handler() }
