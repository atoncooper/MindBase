package cluster

// Tests for the node roster: heartbeat registration, liveness computation,
// deregistration on graceful stop, and the dead-node takeover query.

import (
	"testing"
	"time"

	"app-task/internal/db"
	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func setupClusterDB(t *testing.T) {
	t.Helper()
	gdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, _ := gdb.DB()
	sqlDB.SetMaxOpenConns(1)
	if err := gdb.AutoMigrate(&model.ClusterNode{}, &model.Task{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	db.DB = gdb
}

func TestHeartbeatRegisterAndLiveness(t *testing.T) {
	setupClusterDB(t)
	m := NewManager(Options{NodeID: "n1", Version: "test", Heartbeat: 10 * time.Second})
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	defer m.Stop()

	nodes, err := m.Nodes(time.Now())
	if err != nil || len(nodes) != 1 {
		t.Fatalf("nodes = %v %v, want exactly n1", nodes, err)
	}
	if !nodes[0].Alive || !nodes[0].Self || nodes[0].NodeID != "n1" {
		t.Fatalf("node = %+v", nodes[0])
	}

	// 心跳回拨超过 TTL → 判死
	db.DB.Model(&model.ClusterNode{}).Where("node_id = ?", "n1").
		Update("last_heartbeat", time.Now().UTC().Add(-time.Minute))
	if dead := m.DeadNodes(); len(dead) != 1 || dead[0] != "n1" {
		t.Fatalf("dead = %v, want [n1]", dead)
	}
	nodes, _ = m.Nodes(time.Now())
	if nodes[0].Alive {
		t.Fatal("stale heartbeat must not be alive")
	}
}

func TestDeregisterOnStop(t *testing.T) {
	setupClusterDB(t)
	m := NewManager(Options{NodeID: "n2", Heartbeat: 10 * time.Second})
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	m.Stop() // 优雅注销：名册行立即删除

	nodes, err := m.Nodes(time.Now())
	if err != nil || len(nodes) != 0 {
		t.Fatalf("nodes after stop = %v %v, want empty roster", nodes, err)
	}
}

func TestHeartbeatWritesWeight(t *testing.T) {
	setupClusterDB(t)
	m := NewManager(Options{NodeID: "w4", Weight: 4, Heartbeat: 10 * time.Second})
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	defer m.Stop()

	nodes, _ := m.Nodes(time.Now())
	if len(nodes) != 1 || nodes[0].Weight != 4 {
		t.Fatalf("nodes = %+v, want weight 4", nodes)
	}
	if w := m.MaxAliveWeight(); w != 4 {
		t.Fatalf("max alive weight = %d, want 4", w)
	}
}

// ── 准入闸门：pre_approved 模式下未预登记的节点拒绝注册 ───────────────

func TestAdmissionPreApproved(t *testing.T) {
	setupClusterDB(t)

	// 未预登记 → Start 拒绝（fail-closed）
	rogue := NewManager(Options{NodeID: "rogue", Admission: "pre_approved", Heartbeat: 10 * time.Second})
	if err := rogue.Start(); err == nil {
		t.Fatal("unregistered node must fail startup in pre_approved mode")
	}
	nodes, _ := rogue.Nodes(time.Now())
	if len(nodes) != 0 {
		t.Fatalf("roster = %d rows, want 0 (failed node must not register)", len(nodes))
	}

	// 经加入流程预登记（等价于控制台/at node join）→ 注册成功并转正
	if _, err := repo.JoinNode(&model.ClusterNode{
		NodeID: "approved", Weight: 4, State: repo.NodeStatePendingJoin, JoinedVia: "cli", InvitedBy: "admin",
	}); err != nil {
		t.Fatal(err)
	}
	ok := NewManager(Options{NodeID: "approved", Weight: 4, Admission: "pre_approved", Heartbeat: 10 * time.Second})
	if err := ok.Start(); err != nil {
		t.Fatalf("pre-registered node start = %v, want success", err)
	}
	defer ok.Stop()
	nodes, _ = ok.Nodes(time.Now())
	if len(nodes) != 1 || nodes[0].State != "active" || nodes[0].Weight != 4 {
		t.Fatalf("nodes = %+v, want approved/active/4", nodes)
	}

	// open 模式：未预登记也能注册（默认行为不变）
	open := NewManager(Options{NodeID: "open-node", Admission: "open", Heartbeat: 10 * time.Second})
	if err := open.Start(); err != nil {
		t.Fatalf("open mode start = %v, want nil", err)
	}
	defer open.Stop()
}
