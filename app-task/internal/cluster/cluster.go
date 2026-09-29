// Package cluster manages the app-task node roster: registration, heartbeats,
// liveness and dead-node takeover. It is deliberately NOT a coordinator —
// dispatch/scheduling stay claim-based in the task table (conditional updates
// + fencing tokens, see internal/repo); this package only answers "who is in
// the cluster and is it alive", and lets survivors take over a dead node's
// in-flight claims immediately instead of waiting out the per-claim TTL.
package cluster

import (
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/google/uuid"
)

// Defaults (overridable via Options).
const (
	defaultHeartbeat = 10 * time.Second
	// AliveBeats: a node is dead after this many missed beats.
	AliveBeats = 3
	// Forensics rows (crashed instances never deregister) are pruned after a day.
	pruneAfter = 24 * time.Hour
)

// Manager owns one node's roster membership: register on Start, heartbeat on
// an interval, deregister on graceful Stop. Crashed instances skip Stop —
// their rows go stale and are detected dead by the survivors.
type Manager struct {
	nodeID   string
	hostname string
	version  string
	weight   int

	heartbeat time.Duration
	aliveTTL  time.Duration
	admission string

	stopCh chan struct{}
	wg     sync.WaitGroup
}

// Options configures the cluster manager. Zero values fall back to defaults.
type Options struct {
	NodeID    string        // cluster identity; MUST match the scheduler owner (default hostname+rand)
	Version   string        // build version shown in the roster
	Heartbeat time.Duration // beat interval (default 10s)
	Weight    int           // dispatch share advertised in the roster (default 1)
	// Admission: "open" (default) or "pre_approved". In pre_approved mode a
	// node that was not pre-registered via the join flow fails its first
	// heartbeat — the caller (serve) treats that as fatal so a misconfigured
	// instance can never silently join the roster.
	Admission string
}

// AliveTTL is the liveness window derived from the beat interval.
func (o Options) aliveTTL() time.Duration {
	hb := o.Heartbeat
	if hb <= 0 {
		hb = defaultHeartbeat
	}
	return AliveBeats * hb
}

func NewManager(opts Options) *Manager {
	nodeID := opts.NodeID
	if nodeID == "" {
		host, _ := os.Hostname()
		nodeID = host + "-" + uuid.NewString()[:8]
	}
	hostname, _ := os.Hostname()
	hb := opts.Heartbeat
	if hb <= 0 {
		hb = defaultHeartbeat
	}
	weight := opts.Weight
	if weight <= 0 {
		weight = 1
	}
	return &Manager{
		nodeID:    nodeID,
		hostname:  hostname,
		version:   opts.Version,
		weight:    weight,
		heartbeat: hb,
		aliveTTL:  opts.aliveTTL(),
		admission: opts.Admission,
		stopCh:    make(chan struct{}),
	}
}

// NodeID is this node's cluster identity (same value the scheduler uses as
// task.owner).
func (m *Manager) NodeID() string { return m.nodeID }

// AliveTTL is the liveness window used by DeadNodes.
func (m *Manager) AliveTTL() time.Duration { return m.aliveTTL }

// Start performs the initial registration beat and launches the heartbeat
// loops. The returned error is fatal for the caller: in pre_approved mode a
// missing pre-registration fails startup closed (a misconfigured instance can
// never silently join), and in any mode a registration error means the DB is
// unreachable — the scheduler has nothing to work with anyway.
func (m *Manager) Start() error {
	if err := m.beat(); err != nil {
		return fmt.Errorf("cluster registration (node_id=%s): %w", m.nodeID, err)
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		ticker := time.NewTicker(m.heartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-m.stopCh:
				return
			case <-ticker.C:
				if err := m.beat(); err != nil {
					// DB down = the whole cluster is down anyway; keep retrying.
					slog.Warn("[CLUSTER] heartbeat failed", "node_id", m.nodeID, "err", err)
				}
			}
		}
	}()
	// Forensics prune: drop roster rows dead for over a day.
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-m.stopCh:
				return
			case <-ticker.C:
				if n, err := repo.PruneStaleNodes(time.Now().UTC().Add(-pruneAfter)); err == nil && n > 0 {
					slog.Info("[CLUSTER] pruned stale roster rows", "count", n)
				}
			}
		}
	}()
	slog.Info("[CLUSTER] node registered", "node_id", m.nodeID, "heartbeat", m.heartbeat, "alive_ttl", m.aliveTTL, "admission", m.admission)
	return nil
}

// Stop deregisters the node (graceful shutdown: survivors see it leave
// immediately instead of waiting out the liveness TTL). Waits for the
// heartbeat goroutines so a racing beat cannot resurrect the row after
// deregistration.
func (m *Manager) Stop() {
	close(m.stopCh)
	m.wg.Wait()
	if _, err := repo.DeleteNode(m.nodeID); err != nil {
		slog.Warn("[CLUSTER] deregister failed", "node_id", m.nodeID, "err", err)
	} else {
		slog.Info("[CLUSTER] node deregistered", "node_id", m.nodeID)
	}
}

func (m *Manager) beat() error {
	now := time.Now().UTC()
	// Governance gate: pre_approved admission requires a pre-registration
	// (console cluster page or `at node join`) BEFORE the node may join. The
	// gate is governance/audit, not a defense against a malicious holder of
	// the shared DB credentials — such a holder already has full write access
	// and is outside this trust boundary.
	if m.admission == "pre_approved" {
		row, err := repo.GetClusterNode(m.nodeID)
		if err != nil {
			return err
		}
		if row == nil {
			return fmt.Errorf("admission=pre_approved: node %q is not pre-registered — join via the console cluster page or `at node join` first", m.nodeID)
		}
	}
	return repo.UpsertNodeHeartbeat(&model.ClusterNode{
		NodeID:        m.nodeID,
		Hostname:      m.hostname,
		Version:       m.version,
		Weight:        m.weight,
		StartedAt:     now,
		LastHeartbeat: now,
	})
}

// MaxAliveWeight returns the highest dispatch weight among alive roster
// nodes (0 when the roster is empty/unavailable). The scheduler scales its
// claim limit by ownWeight / maxAliveWeight.
func (m *Manager) MaxAliveWeight() int {
	w, err := repo.MaxAliveNodeWeight(time.Now().UTC().Add(-m.aliveTTL))
	if err != nil {
		slog.Warn("[CLUSTER] max alive weight query failed", "err", err)
		return 0
	}
	return w
}

// DeadNodes returns roster nodes whose heartbeat is older than the liveness
// TTL. The scheduler uses this to fast-take-over their dispatching claims.
func (m *Manager) DeadNodes() []string {
	ids, err := repo.DeadNodeIDs(time.Now().UTC().Add(-m.aliveTTL))
	if err != nil {
		slog.Warn("[CLUSTER] dead node query failed", "err", err)
		return nil
	}
	return ids
}

// NodeView is the roster row shaped for the console/CLI: liveness computed,
// in-flight claim count attached.
type NodeView struct {
	NodeID        string `json:"node_id"`
	Hostname      string `json:"hostname"`
	Version       string `json:"version"`
	Weight        int    `json:"weight"`
	State         string `json:"state"` // active / pending_join
	JoinedVia     string `json:"joined_via,omitempty"`
	InvitedBy     string `json:"invited_by,omitempty"`
	StartedAt     string `json:"started_at"`
	LastHeartbeat string `json:"last_heartbeat"`
	Alive         bool   `json:"alive"`
	Claims        int64  `json:"claims"`
	Self          bool   `json:"self"`
}

// Nodes renders the roster with liveness + claim counts.
func (m *Manager) Nodes(now time.Time) ([]NodeView, error) {
	rows, err := repo.ListNodes()
	if err != nil {
		return nil, err
	}
	claims, err := repo.CountDispatchingByOwner()
	if err != nil {
		return nil, err
	}
	out := make([]NodeView, 0, len(rows))
	for _, r := range rows {
		out = append(out, NodeView{
			NodeID:        r.NodeID,
			Hostname:      r.Hostname,
			Version:       r.Version,
			Weight:        r.Weight,
			State:         r.State,
			JoinedVia:     r.JoinedVia,
			InvitedBy:     r.InvitedBy,
			StartedAt:     r.StartedAt.UTC().Format(time.RFC3339),
			LastHeartbeat: r.LastHeartbeat.UTC().Format(time.RFC3339),
			Alive:         now.Sub(r.LastHeartbeat) < m.aliveTTL,
			Claims:        claims[r.NodeID],
			Self:          r.NodeID == m.nodeID,
		})
	}
	return out, nil
}
