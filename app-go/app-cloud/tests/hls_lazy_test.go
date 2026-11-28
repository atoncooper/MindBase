package tests

// Lazy-enqueue semantics for GET /cloud/video/:uuid/hls.
//
// Background: most cloud-drive videos predate HLS or missed the MinIO webhook,
// so they have *no* Redis status. The API used to answer status=processing for
// them, which the viewer rendered as an endless "packaging" spinner. The
// decision helper below is the single source of truth for when a read may
// enqueue a job, and it must never re-encode ready output or storm on a broken
// source.

import (
	"testing"

	"app-cloud/internal/service"
)

func TestLazyEnqueueDecision(t *testing.T) {
	const (
		now         = int64(1_800_000_000)
		cooldown    = int64(600) // hlsFailedRetryCooldown
		maxAttempts = 3
	)
	cases := []struct {
		name string
		in   service.LazyEnqueueInput
		on   bool
		want bool
	}{
		{
			name: "never enqueued is lazily enqueued",
			in:   service.LazyEnqueueInput{},
			on:   true,
			want: true,
		},
		{
			name: "never enqueued but lazy flag off stays untouched",
			in:   service.LazyEnqueueInput{},
			on:   false,
			want: false,
		},
		{
			name: "failed retryable after cooldown is retried",
			in: service.LazyEnqueueInput{
				Status: "failed", Retryable: true, Attempts: 1, UpdatedAt: now - cooldown - 1,
			},
			on:   true,
			want: true,
		},
		{
			name: "failed retryable inside cooldown is not retried",
			in: service.LazyEnqueueInput{
				Status: "failed", Retryable: true, Attempts: 1, UpdatedAt: now - cooldown + 60,
			},
			on:   true,
			want: false,
		},
		{
			name: "failed non-retryable is terminal",
			in: service.LazyEnqueueInput{
				Status: "failed", Retryable: false, Attempts: 1, UpdatedAt: now - 86_400,
			},
			on:   true,
			want: false,
		},
		{
			name: "failed with attempts exhausted is terminal",
			in: service.LazyEnqueueInput{
				Status: "failed", Retryable: true, Attempts: maxAttempts, UpdatedAt: now - 86_400,
			},
			on:   true,
			want: false,
		},
		{
			name: "queued is left to the existing job",
			in:   service.LazyEnqueueInput{Status: "queued", UpdatedAt: now - 86_400},
			on:   true,
			want: false,
		},
		{
			name: "processing is left to the existing job",
			in:   service.LazyEnqueueInput{Status: "processing", UpdatedAt: now - 86_400},
			on:   true,
			want: false,
		},
		{
			name: "ready is never re-encoded",
			in:   service.LazyEnqueueInput{Status: "ready", UpdatedAt: now},
			on:   true,
			want: false,
		},
		{
			name: "unsupported is terminal",
			in:   service.LazyEnqueueInput{Status: "unsupported"},
			on:   true,
			want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := service.LazyEnqueueDecision(tc.in, tc.on, maxAttempts, now); got != tc.want {
				t.Fatalf("LazyEnqueueDecision(%+v, enabled=%v) = %v, want %v", tc.in, tc.on, got, tc.want)
			}
		})
	}
}
