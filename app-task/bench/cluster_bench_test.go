package bench

// Cluster roster benchmarks: heartbeat upsert and join pre-registration.

import (
	"fmt"
	"testing"
	"time"

	"app-task/internal/model"
	"app-task/internal/repo"
)

// BenchmarkNodeHeartbeat measures one heartbeat upsert (update path — the
// steady state every live node hits every 10s).
func BenchmarkNodeHeartbeat(b *testing.B) {
	setupDB(b)
	node := &model.ClusterNode{
		NodeID: "bench-node", Hostname: "bench-host", Version: "bench",
		Weight: 4, StartedAt: time.Now().UTC(),
	}
	if err := repo.UpsertNodeHeartbeat(node); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		node.LastHeartbeat = time.Now().UTC()
		if err := repo.UpsertNodeHeartbeat(node); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkJoinPreRegister measures the join pre-registration upsert: a
// rotating pool of 100 node ids, refreshed on every wrap (create on first
// use, update after) — both code paths exercised.
func BenchmarkJoinPreRegister(b *testing.B) {
	setupDB(b)
	const pool = 100
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		id := fmt.Sprintf("bench-join-%d", i%pool)
		if _, err := repo.JoinNode(&model.ClusterNode{
			NodeID:    id,
			Hostname:  fmt.Sprintf("host-%d", i%pool),
			Weight:    1 + i%4,
			State:     repo.NodeStatePendingJoin,
			JoinedVia: "cli",
			InvitedBy: "bench",
		}); err != nil {
			// active conflict cannot happen here: rows stay pending forever
			b.Fatal(err)
		}
	}
}
