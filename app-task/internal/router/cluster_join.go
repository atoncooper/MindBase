// Package router: cluster join flow — admin pre-registers a node (web form or
// `at node join`), the API returns copy-pasteable instructions for the new
// node, and its first heartbeat activates the pre-registered row. The DB
// connection string is NEVER echoed through the API (security boundary):
// instructions carry a <SHARED_DB_URL> placeholder and the operator fetches
// the real DSN from the secret-distribution channel.
package router

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/gin-gonic/gin"
)

// clusterJoinRequest is the shared body for the web form and the CLI join.
type clusterJoinRequest struct {
	NodeID   string `json:"node_id" form:"node_id" binding:"required,max=64"`
	Weight   int    `json:"weight" form:"weight"`
	Hostname string `json:"hostname" form:"hostname,max=128"`
	Via      string `json:"via" form:"via"` // cli / web (audit)
}

// maxNodeWeight caps the dispatch share a single node may claim — far above
// any real deployment, low enough that weighted-claim math can never overflow.
const maxNodeWeight = 1000

// nodeIDRe restricts node identifiers to URL/log/identifier-safe characters:
// node_id flows into slog lines, the roster HTML, task.owner and the join
// redirect — anything outside this set is either a log-injection or a
// downstream-parsing hazard.
var nodeIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$`)

// validateClusterJoin checks the join request fields; returns an
// HTTP-ready error message ("" when valid).
func validateClusterJoin(nodeID, hostname string, weight int) string {
	if !nodeIDRe.MatchString(nodeID) {
		return "node_id 需 2–64 字符，仅限字母/数字/点/下划线/连字符，字母或数字开头"
	}
	if strings.ContainsAny(hostname, "\n\r\t") {
		return "hostname 不能包含换行/制表符"
	}
	if weight < 1 || weight > maxNodeWeight {
		return fmt.Sprintf("weight 需 1–%d", maxNodeWeight)
	}
	return ""
}

// clusterJoinInstructions renders the copy-paste onboarding snippet for a
// pre-registered node. admission is the server's cluster.admission mode: in
// pre_approved mode the pre-registration is a hard prerequisite (the node
// refuses to start without it) and the snippet says so.
func clusterJoinInstructions(nodeID string, weight int, admission string) string {
	admissionNote := ""
	if admission == "pre_approved" {
		admissionNote = "\n\n# ⚠ 集群准入为 pre_approved 模式：必须先完成本预登记再启动新节点，\n# 否则新节点会因未注册而拒绝启动（fail-closed）。"
	}
	return fmt.Sprintf(`# 1. 新节点环境变量（.env 或 compose environment；RDBMS URL 从密钥渠道获取）
APPTASK__RDBMS__URL=<SHARED_DB_URL>            # 与集群共享的 MySQL 连接串（不要用本文件占位符）
APPTASK__SCHEDULER__INSTANCE_ID=%s
APPTASK__SCHEDULER__WEIGHT=%d

# 2. 启动（任一方式）
docker compose up -d app-task          # 与集群共享 DB 的实例
# 或：at serve

# 3. 验证加入（节点首次心跳后自动从 pending_join 转为 active）
at node ls                             # 出现 %s 即加入成功%s`, nodeID, weight, nodeID, admissionNote)
}

// apiClusterJoin pre-registers a node (admin only). 409 when the node_id is
// already an active member; the pending row is refreshed on repeat joins.
func (r *Router) apiClusterJoin(c *gin.Context) {
	var req clusterJoinRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request: " + err.Error()})
		return
	}
	req.NodeID = strings.TrimSpace(req.NodeID)
	if req.Weight <= 0 {
		req.Weight = 1
	}
	if msg := validateClusterJoin(req.NodeID, strings.TrimSpace(req.Hostname), req.Weight); msg != "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": msg})
		return
	}
	weight := req.Weight
	via := req.Via
	if via != "cli" {
		via = "web"
	}
	operator := ""
	if s, ok := currentUser(c); ok {
		operator = s.Username
	}
	created, err := repo.JoinNode(&model.ClusterNode{
		NodeID:    req.NodeID,
		Hostname:  strings.TrimSpace(req.Hostname),
		Weight:    weight,
		State:     repo.NodeStatePendingJoin,
		JoinedVia: via,
		InvitedBy: operator,
	})
	if err == repo.ErrNodeActive {
		c.JSON(http.StatusConflict, gin.H{"detail": "节点已在集群中（active）：" + req.NodeID})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	state := "updated"
	if created {
		state = "pending_join"
	}
	c.JSON(http.StatusOK, gin.H{
		"node_id":      req.NodeID,
		"weight":       weight,
		"state":        state,
		"invited_by":   operator,
		"created":      created,
		"instructions": clusterJoinInstructions(req.NodeID, weight, r.cfg.Cluster.Admission),
		"expires_hint": "预登记 24 小时无人接入将被自动清理，可重新生成",
		"generated_at": time.Now().UTC().Format(time.RFC3339),
	})
}
