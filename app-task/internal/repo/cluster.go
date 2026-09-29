// Package repo: cluster node roster (cluster_node table) — heartbeat upserts,
// liveness queries, dead-node claim takeover and roster pruning.
package repo

import (
	"errors"
	"time"

	"app-task/internal/db"
	"app-task/internal/model"

	"gorm.io/gorm"
)

// Node roster states.
const (
	NodeStateActive      = "active"       // heartbeat-registered member
	NodeStatePendingJoin = "pending_join" // pre-registered via join flow, awaiting first heartbeat
)

// UpsertNodeHeartbeat registers the node on first beat and refreshes
// last_heartbeat on every subsequent one (idempotent by node_id). A pending
// pre-registered row (from the console/CLI join flow) is activated on the
// node's first heartbeat, keeping its invited-by provenance; self-registered
// rows (no pre-registration) are marked joined_via=auto.
func UpsertNodeHeartbeat(n *model.ClusterNode) error {
	var existing model.ClusterNode
	err := db.DB.Where("node_id = ?", n.NodeID).First(&existing).Error
	if err == nil {
		updates := map[string]any{
			"hostname":       n.Hostname,
			"version":        n.Version,
			"weight":         n.Weight,
			"last_heartbeat": n.LastHeartbeat,
			"state":          NodeStateActive,
			"updated_at":     time.Now().UTC(),
		}
		if existing.State == NodeStatePendingJoin {
			// Activation from a pre-registration: the node's real process start
			// time is unknown — first heartbeat is the closest fact.
			updates["started_at"] = n.LastHeartbeat
		}
		return db.DB.Model(&model.ClusterNode{}).Where("node_id = ?", n.NodeID).
			Updates(updates).Error
	}
	if err == gorm.ErrRecordNotFound {
		n.State = NodeStateActive
		if n.JoinedVia == "" {
			n.JoinedVia = "auto"
		}
		return db.DB.Create(n).Error
	}
	return err
}

// JoinNode pre-registers a node via the console/CLI join flow: the row sits in
// state=pending_join until the node's first heartbeat activates it. Idempotent
// for the same node_id (weight updated); an already-active node_id is refused
// (ErrNodeActive). The invited_by operator is recorded for audit.
func JoinNode(n *model.ClusterNode) (created bool, err error) {
	var existing model.ClusterNode
	err = db.DB.Where("node_id = ?", n.NodeID).First(&existing).Error
	if err == nil {
		if existing.State == NodeStateActive {
			return false, ErrNodeActive
		}
		// pending row exists: refresh the invitation (weight/invited_by).
		return false, db.DB.Model(&model.ClusterNode{}).Where("node_id = ?", n.NodeID).
			Updates(map[string]any{
				"weight":     n.Weight,
				"invited_by": n.InvitedBy,
				// refresh the clock so the 24h prune does not eat a pending
				// invitation that is still being worked on
				"last_heartbeat": time.Now().UTC(),
				"updated_at":     time.Now().UTC(),
			}).Error
	}
	if err == gorm.ErrRecordNotFound {
		n.State = NodeStatePendingJoin
		return true, db.DB.Create(n).Error
	}
	return false, err
}

// ErrNodeActive is returned by JoinNode when the node_id is already an active
// roster member.
var ErrNodeActive = errors.New("cluster: node already active")

// MaxAliveNodeWeight returns the highest dispatch weight among nodes whose
// heartbeat is still fresh (0 when the roster is empty). The scheduler
// scales its claim limit by ownWeight / this value.
func MaxAliveNodeWeight(olderThan time.Time) (int, error) {
	var w *int
	err := db.DB.Model(&model.ClusterNode{}).
		Select("MAX(weight)").
		Where("last_heartbeat >= ?", olderThan).
		Scan(&w).Error
	if err != nil || w == nil {
		return 0, err
	}
	return *w, nil
}

// DeleteNode removes the node's roster row (graceful deregistration).
func DeleteNode(nodeID string) (bool, error) {
	res := db.DB.Where("node_id = ?", nodeID).Delete(&model.ClusterNode{})
	return res.RowsAffected > 0, res.Error
}

// ListNodes returns the roster, freshest heartbeat first.
func ListNodes() ([]model.ClusterNode, error) {
	var out []model.ClusterNode
	err := db.DB.Order("last_heartbeat DESC").Find(&out).Error
	return out, err
}

// DeadNodeIDs returns nodes whose heartbeat is older than the liveness TTL.
func DeadNodeIDs(olderThan time.Time) ([]string, error) {
	var ids []string
	err := db.DB.Model(&model.ClusterNode{}).
		Where("last_heartbeat < ?", olderThan).
		Pluck("node_id", &ids).Error
	return ids, err
}

// PruneStaleNodes drops roster rows that have been dead for a long time
// (crashed instances never deregister; the row is kept for forensics until
// this prune). Returns the number of removed rows.
func PruneStaleNodes(olderThan time.Time) (int64, error) {
	res := db.DB.Where("last_heartbeat < ?", olderThan).Delete(&model.ClusterNode{})
	return res.RowsAffected, res.Error
}

// CountDispatchingByOwner returns how many dispatching claims each owner
// holds (cluster view: which node is carrying what).
func CountDispatchingByOwner() (map[string]int64, error) {
	var rows []struct {
		Owner string `gorm:"column:owner"`
		Count int64  `gorm:"column:count"`
	}
	err := db.DB.Model(&model.Task{}).
		Select("owner, COUNT(*) AS count").
		Where("status = ? AND owner <> ''", StatusDispatching).
		Group("owner").Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(rows))
	for _, r := range rows {
		out[r.Owner] = r.Count
	}
	return out, nil
}

// ReclaimDispatchingForNodes takes over dispatching claims owned by dead
// nodes immediately (fast path; the per-claim TTL sweep remains the fallback
// for nodes whose roster row is missing entirely). Correctness is unaffected
// either way — finalizes are fenced by claim token.
func ReclaimDispatchingForNodes(nodeIDs []string) (int64, error) {
	if len(nodeIDs) == 0 {
		return 0, nil
	}
	res := db.DB.Model(&model.Task{}).
		Where("status = ? AND owner IN ?", StatusDispatching, nodeIDs).
		Updates(map[string]any{
			"status":      "pending",
			"owner":       "",
			"claimed_at":  nil,
			"claim_token": "",
			"updated_at":  time.Now().UTC(),
		})
	return res.RowsAffected, res.Error
}

// GetClusterNode returns one roster row by node_id; nil, nil when absent.
func GetClusterNode(nodeID string) (*model.ClusterNode, error) {
	var out model.ClusterNode
	err := db.DB.Where("node_id = ?", nodeID).First(&out).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	return &out, err
}
