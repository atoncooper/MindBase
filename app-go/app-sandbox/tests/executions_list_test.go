package tests

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"app-sandbox/internal/model"
	"app-sandbox/internal/runtime"
)

// listExecutions calls GET /v1/executions with the given query string and
// returns the decoded items. It fails when the payload is null (the contract
// requires an array, empty or not).
func (h *harness) listExecutions(t *testing.T, uid int64, query string) []map[string]any {
	t.Helper()
	rec := h.do(t, http.MethodGet, "/v1/executions"+query, nil, authHeaders(uid))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /v1/executions%s = %d body=%s", query, rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	raw, ok := body["executions"].([]any)
	if !ok {
		t.Fatalf("executions must be an array, got %T (%v)", body["executions"], body["executions"])
	}
	items := make([]map[string]any, 0, len(raw))
	for _, entry := range raw {
		row, ok := entry.(map[string]any)
		if !ok {
			t.Fatalf("execution entry must be an object, got %T", entry)
		}
		items = append(items, row)
	}
	return items
}

func executionIDs(items []map[string]any) []string {
	ids := make([]string, 0, len(items))
	for _, item := range items {
		id, _ := item["executionId"].(string)
		ids = append(ids, id)
	}
	return ids
}

// seedExecutions writes n rows directly into the memory repo so the list limits
// can be exercised without producing real runs.
func (h *harness) seedExecutions(t *testing.T, uid int64, n int, base time.Time) []string {
	t.Helper()
	ids := make([]string, 0, n)
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("seed-%d-%02d", uid, i)
		row := &model.SandboxExecution{
			ID:        id,
			UID:       uid,
			Language:  "python",
			Status:    model.ExecStatusSucceeded,
			TimeoutMS: 1000,
			CreatedAt: base.Add(time.Duration(i) * time.Second),
		}
		if err := h.store.CreateExecution(context.Background(), row); err != nil {
			t.Fatalf("seed execution %s: %v", id, err)
		}
		ids = append(ids, id)
	}
	return ids
}

func TestListExecutionsFiltersByUID(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)

	mine1 := h.createExecution(t, 91, executionBody(nil))
	h.pollDone(t, 91, mine1)
	mine2 := h.createExecution(t, 91, executionBody(nil))
	h.pollDone(t, 91, mine2)
	foreign := h.createExecution(t, 92, executionBody(nil))
	h.pollDone(t, 92, foreign)

	items := h.listExecutions(t, 91, "")
	if len(items) != 2 {
		t.Fatalf("uid 91 executions = %d, want 2 (%v)", len(items), executionIDs(items))
	}
	seen := map[string]bool{}
	for _, item := range items {
		id, _ := item["executionId"].(string)
		seen[id] = true
		if id == foreign {
			t.Fatalf("uid 91 list leaked uid 92 execution %s", foreign)
		}
		if done, ok := item["done"].(bool); !ok || !done {
			t.Fatalf("execution %s done = %v, want true", id, item["done"])
		}
	}
	if !seen[mine1] || !seen[mine2] {
		t.Fatalf("uid 91 list = %v, want both %s and %s", executionIDs(items), mine1, mine2)
	}

	foreignItems := h.listExecutions(t, 92, "")
	if len(foreignItems) != 1 || executionIDs(foreignItems)[0] != foreign {
		t.Fatalf("uid 92 list = %v, want [%s]", executionIDs(foreignItems), foreign)
	}
}

func TestListExecutionsIncludesArtifacts(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)
	id := h.createExecution(t, 93, executionBody(nil))
	h.pollDone(t, 93, id)

	artifact := model.SandboxArtifact{
		ID:          "artifact-1",
		ExecutionID: id,
		UID:         93,
		Name:        "result.txt",
		ObjectKey:   "sandbox-artifacts/93/result.txt",
		SizeBytes:   12,
		SHA256:      "deadbeef",
		ContentType: "text/plain",
		CreatedAt:   time.Now(),
	}
	if err := h.store.CreateArtifacts(context.Background(), []model.SandboxArtifact{artifact}); err != nil {
		t.Fatalf("seed artifact: %v", err)
	}

	items := h.listExecutions(t, 93, "")
	if len(items) != 1 {
		t.Fatalf("executions = %d, want 1", len(items))
	}
	artifacts, ok := items[0]["artifacts"].([]any)
	if !ok {
		t.Fatalf("artifacts must be an array, got %T", items[0]["artifacts"])
	}
	if len(artifacts) != 1 {
		t.Fatalf("artifacts = %d, want 1", len(artifacts))
	}
	first, _ := artifacts[0].(map[string]any)
	if first["name"] != "result.txt" {
		t.Fatalf("artifact name = %v, want result.txt", first["name"])
	}
	if size, _ := first["size"].(float64); int64(size) != 12 {
		t.Fatalf("artifact size = %v, want 12", first["size"])
	}
	if url, _ := first["url"].(string); !strings.Contains(url, "result.txt") {
		t.Fatalf("artifact url = %q, want a presigned URL", url)
	}
}

func TestListExecutionsLimitDefaultAndClamp(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)
	// 60 rows, oldest first; createdAt is unique per row so the ordering is total.
	ids := h.seedExecutions(t, 94, 60, time.Now().Add(-time.Hour))
	newest := ids[len(ids)-1]

	cases := []struct {
		name  string
		query string
		want  int
	}{
		{"default", "", 20},
		{"explicit small", "?limit=5", 5},
		{"single", "?limit=1", 1},
		{"above cap is clamped", "?limit=100", 50},
		{"cap boundary", "?limit=50", 50},
		{"zero falls back to default", "?limit=0", 20},
		{"negative falls back to default", "?limit=-3", 20},
		{"non numeric falls back to default", "?limit=abc", 20},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			items := h.listExecutions(t, 94, tc.query)
			if len(items) != tc.want {
				t.Fatalf("limit %q returned %d rows, want %d", tc.query, len(items), tc.want)
			}
			// Newest first: the most recent seeded row always leads.
			if got := executionIDs(items)[0]; got != newest {
				t.Fatalf("first row = %s, want newest %s", got, newest)
			}
			// Artifacts stay an array even when the row has none.
			if artifacts, ok := items[0]["artifacts"].([]any); !ok || len(artifacts) != 0 {
				t.Fatalf("artifacts = %v, want []", items[0]["artifacts"])
			}
		})
	}

	// Rows below the returned window must be the next newest ones.
	items := h.listExecutions(t, 94, "?limit=5")
	wantIDs := []string{ids[59], ids[58], ids[57], ids[56], ids[55]}
	gotIDs := executionIDs(items)
	for i := range wantIDs {
		if gotIDs[i] != wantIDs[i] {
			t.Fatalf("limit=5 order = %v, want %v", gotIDs, wantIDs)
		}
	}
}

func TestListExecutionsEmptyList(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)
	items := h.listExecutions(t, 95, "")
	if len(items) != 0 {
		t.Fatalf("empty list returned %d rows", len(items))
	}
	// The encoded body must be "executions":[] (not null).
	rec := h.do(t, http.MethodGet, "/v1/executions", nil, authHeaders(95))
	if !strings.Contains(rec.Body.String(), "\"executions\":[]") {
		t.Fatalf("empty payload = %s, want executions:[]", rec.Body.String())
	}
}

func TestListExecutionsRequiresAuth(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)
	cases := []struct {
		name    string
		headers map[string]string
	}{
		{"no api key", map[string]string{"X-Uid": "1"}},
		{"missing uid", map[string]string{"X-API-Key": testAPIKey}},
		{"invalid uid", map[string]string{"X-API-Key": testAPIKey, "X-Uid": "abc"}},
		{"non positive uid", map[string]string{"X-API-Key": testAPIKey, "X-Uid": "0"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := h.do(t, http.MethodGet, "/v1/executions", nil, tc.headers)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401 (body=%s)", rec.Code, rec.Body.String())
			}
			if body := decode(t, rec); body["detail"] == "" || body["detail"] == nil {
				t.Fatalf("401 body has no detail: %s", rec.Body.String())
			}
		})
	}
}
