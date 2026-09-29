// Package model defines the GORM models for app-task's OWN database
// (independent MySQL instance, schema owned by app-task; created via
// db.Migrate at startup).
//
// app-task is a pure scheduler: it only stores the task definition and the
// execution log. All business logic lives in third-party executors — the
// scheduler dispatches (HTTP to executor_url, or an optional built-in Lua
// executor) and records the outcome. No business models live here.
package model

import (
	"time"

	"gorm.io/datatypes"
)

// Task is the scheduler's generic task definition (pure scheduling, no
// business). State machine:
//
//	pending -> running (async accepted) -> completed | failed
//	pending -> completed (sync success)
//	failed/any -> pending (retry with next_retry_at)
type Task struct {
	ID             int64          `gorm:"primaryKey;autoIncrement" json:"-"`
	TaskID         string         `gorm:"column:task_id;uniqueIndex;size:64;not null" json:"task_id"`
	UID            int64          `gorm:"column:uid;index;not null" json:"uid"`                                // owner
	TaskType       string         `gorm:"column:task_type;size:32;default:http;not null" json:"task_type"`     // http (default) / lua / ...
	Payload        datatypes.JSON `gorm:"column:payload;type:json" json:"payload,omitempty"`                   // opaque task parameters, passed to the executor verbatim
	ExecutorURL    string         `gorm:"column:executor_url;size:512" json:"executor_url,omitempty"`          // http mode: third-party executor endpoint
	Async          bool           `gorm:"column:async;not null" json:"async"`                                  // true: executor replies 202 and reports via callback
	CronExpr       string         `gorm:"column:cron_expr;size:64" json:"cron_expr,omitempty"`                 // 5-field cron; empty = one-shot
	CronNextTaskID string         `gorm:"column:cron_next_task_id;size:64" json:"cron_next_task_id,omitempty"` // next occurrence (dedupe)
	TriggerTime    time.Time      `gorm:"column:trigger_time;not null;index:ix_task_status_trigger,priority:2" json:"trigger_time"`
	Status         string         `gorm:"column:status;size:20;default:pending;not null;index:ix_task_status_trigger,priority:1;index:ix_task_status_next_retry,priority:1" json:"status"`
	// Dispatch claim (transient dispatching state): which scheduler instance
	// holds the task and when it was claimed. ClaimToken is the fencing token
	// (fresh per claim): finalizes/releases only apply while their token is
	// still the live claim, so a stale holder (reclaimed after a >TTL stall)
	// cannot clobber the newer claim. Cleared on finalize/reclaim.
	Owner       string     `gorm:"column:owner;size:64" json:"owner,omitempty"`
	ClaimedAt   *time.Time `gorm:"column:claimed_at" json:"claimed_at,omitempty"`
	ClaimToken  string     `gorm:"column:claim_token;size:36" json:"claim_token,omitempty"`
	MaxRetry    int        `gorm:"column:max_retry;default:0;not null" json:"max_retry"` // 0 = no retry
	RetryCount  int        `gorm:"column:retry_count;default:0;not null" json:"retry_count"`
	NextRetryAt *time.Time `gorm:"column:next_retry_at;index:ix_task_status_next_retry,priority:2" json:"next_retry_at,omitempty"`
	Weight      int        `gorm:"column:weight;default:1;not null" json:"weight"`            // WFQ weight (reserved, M4)
	LastResult  *string    `gorm:"column:last_result;type:text" json:"last_result,omitempty"` // short outcome summary from the last execution
	CreatedAt   time.Time  `gorm:"column:created_at;autoCreateTime" json:"created_at"`
	UpdatedAt   time.Time  `gorm:"column:updated_at;autoUpdateTime" json:"updated_at"`
}

func (Task) TableName() string { return "task" }

// TaskLog is the audit trail of every trigger/execution: which task, which
// executor, what was sent/received, outcome and duration. This is the
// scheduler's only record of what happened (溯源).
type TaskLog struct {
	ID         int64     `gorm:"primaryKey;autoIncrement" json:"-"`
	LogID      string    `gorm:"column:log_id;uniqueIndex;size:64;not null" json:"log_id"`
	TaskID     string    `gorm:"column:task_id;index:ix_task_log_task_id;size:64;not null" json:"task_id"`
	TriggerAt  time.Time `gorm:"column:trigger_at;autoCreateTime" json:"trigger_at"`
	Executor   string    `gorm:"column:executor;size:512" json:"executor,omitempty"` // executor_url or "lua:<script_id>"
	Request    string    `gorm:"column:request;type:text" json:"request,omitempty"`  // payload (truncated)
	Response   string    `gorm:"column:response;type:text" json:"response,omitempty"`
	Status     string    `gorm:"column:status;size:16;not null" json:"status"` // success / failed / timeout / retry
	DurationMS int64     `gorm:"column:duration_ms" json:"duration_ms"`
	Error      *string   `gorm:"column:error;type:text" json:"error,omitempty"`
	CreatedAt  time.Time `gorm:"column:created_at;autoCreateTime" json:"created_at"`
}

func (TaskLog) TableName() string { return "task_log" }

// EmailMessage is a queued email in app-task's mail delivery service. The
// scheduler platform delivers mail on behalf of third-party executors: an
// executor posts a standardized email (to/cc/subject/html) to
// /internal/email/send, app-task persists it here and a worker delivers it
// with retries (crash-safe, at-least-once semantics).
type EmailMessage struct {
	ID          int64          `gorm:"primaryKey;autoIncrement" json:"-"`
	EmailID     string         `gorm:"column:email_id;uniqueIndex;size:64;not null" json:"email_id"`
	To          datatypes.JSON `gorm:"column:to;type:json;not null" json:"to"`
	CC          datatypes.JSON `gorm:"column:cc;type:json" json:"cc,omitempty"`
	Subject     string         `gorm:"column:subject;size:255;not null" json:"subject"`
	BodyHTML    string         `gorm:"column:body_html;type:text;not null" json:"body_html"`
	ReferenceID string         `gorm:"column:reference_id;size:64;index" json:"reference_id,omitempty"`                                                // business correlation id (audit/idempotency)
	Status      string         `gorm:"column:status;size:20;default:pending;not null;index:ix_email_queue_status_next_retry,priority:1" json:"status"` // pending / sent / failed / dry_run
	RetryCount  int            `gorm:"column:retry_count;default:0;not null" json:"retry_count"`
	NextRetryAt *time.Time     `gorm:"column:next_retry_at;index:ix_email_queue_status_next_retry,priority:2" json:"next_retry_at,omitempty"`
	LastError   *string        `gorm:"column:last_error;type:text" json:"last_error,omitempty"`
	// ClaimToken fences the sending state (same pattern as Task.ClaimToken).
	ClaimToken string     `gorm:"column:claim_token;size:36" json:"claim_token,omitempty"`
	CreatedAt  time.Time  `gorm:"column:created_at;autoCreateTime" json:"created_at"`
	UpdatedAt  time.Time  `gorm:"column:updated_at;autoUpdateTime" json:"updated_at"` // also the stale-sending claim clock
	SentAt     *time.Time `gorm:"column:sent_at" json:"sent_at,omitempty"`
}

func (EmailMessage) TableName() string { return "email_queue" }

// Script is a reusable Lua executor script (optional built-in executor;
// xxl-task GLUE-style): script_id identifies the logical script, version
// increments on every upload. Tasks reference it via task_type="lua" +
// payload.script_id; the executor caches the compiled bytecode so edits take
// effect immediately without restarting.
type Script struct {
	ID          int64     `gorm:"primaryKey;autoIncrement" json:"-"`
	ScriptID    string    `gorm:"column:script_id;uniqueIndex:uq_script_id_version;index:ix_script_id;size:64;not null" json:"script_id"`
	Version     int       `gorm:"column:version;uniqueIndex:uq_script_id_version;not null" json:"version"`
	Name        string    `gorm:"column:name;size:128;not null" json:"name"`
	Description string    `gorm:"column:description;size:512" json:"description,omitempty"`
	Source      string    `gorm:"column:source;type:mediumtext;not null" json:"source"`
	Enabled     bool      `gorm:"column:enabled;not null" json:"enabled"`
	CreatedAt   time.Time `gorm:"column:created_at;autoCreateTime" json:"created_at"`
	UpdatedAt   time.Time `gorm:"column:updated_at;autoUpdateTime" json:"updated_at"`
}

func (Script) TableName() string { return "script" }

// ScriptLog is the audit trail for script uploads/edits: who changed which
// script to which version, from where, with what request id.
type ScriptLog struct {
	ID        int64     `gorm:"primaryKey;autoIncrement" json:"-"`
	LogID     string    `gorm:"column:log_id;uniqueIndex;size:64;not null" json:"log_id"`
	ScriptID  string    `gorm:"column:script_id;index;size:64;not null" json:"script_id"`
	Version   int       `gorm:"column:version;not null" json:"version"`
	Action    string    `gorm:"column:action;size:16;not null" json:"action"` // create / update
	Operator  string    `gorm:"column:operator;size:64" json:"operator,omitempty"`
	SourceIP  string    `gorm:"column:source_ip;size:64" json:"source_ip,omitempty"`
	RequestID string    `gorm:"column:request_id;size:64" json:"request_id,omitempty"`
	Summary   string    `gorm:"column:summary;size:255" json:"summary,omitempty"`
	CreatedAt time.Time `gorm:"column:created_at;autoCreateTime" json:"created_at"`
}

func (ScriptLog) TableName() string { return "script_log" }

// WebUIUser is an admin-console account (username + bcrypt password). The
// console always requires login; the default admin account is seeded at
// startup when the table is empty. Only role=admin can manage accounts.
type WebUIUser struct {
	ID           int64     `gorm:"primaryKey;autoIncrement" json:"-"`
	UserID       string    `gorm:"column:user_id;uniqueIndex;size:36" json:"user_id"` // UUID identifier (int64 PK stays internal; legacy rows backfilled at startup)
	Username     string    `gorm:"column:username;uniqueIndex;size:64;not null" json:"username"`
	PasswordHash string    `gorm:"column:password_hash;size:255;not null" json:"-"`
	Role         string    `gorm:"column:role;size:16;default:member;not null" json:"role"` // admin / member
	CreatedAt    time.Time `gorm:"column:created_at;autoCreateTime" json:"created_at"`
}

func (WebUIUser) TableName() string { return "webui_user" }

// ScriptRun records one on-demand script execution (console test-run button or
// the /internal/script/run platform endpoint). Scheduled task executions stay
// in task_log; this table gives ad-hoc runs their own traceable history and
// feeds the console run-result view (captured ctx.log lines included).
type ScriptRun struct {
	ID         int64          `gorm:"primaryKey;autoIncrement" json:"-"`
	RunID      string         `gorm:"column:run_id;uniqueIndex;size:64;not null" json:"run_id"`
	ScriptID   string         `gorm:"column:script_id;index;size:64;not null" json:"script_id"`
	Version    int            `gorm:"column:version;not null" json:"version"`            // script version executed
	Payload    datatypes.JSON `gorm:"column:payload;type:json" json:"payload,omitempty"` // task payload passed to ctx.payload()
	Status     string         `gorm:"column:status;size:16;not null" json:"status"`      // success / retry / failed
	Error      *string        `gorm:"column:error;type:text" json:"error,omitempty"`
	Logs       *string        `gorm:"column:logs;type:text" json:"logs,omitempty"` // ctx.log lines, newline-joined
	DurationMS int64          `gorm:"column:duration_ms" json:"duration_ms"`
	CreatedAt  time.Time      `gorm:"column:created_at;autoCreateTime" json:"created_at"`
}

func (ScriptRun) TableName() string { return "script_run" }

// APIKey is a caller credential for the service surface (/tasks/*, /scripts*,
// /internal/*). The plaintext key is shown exactly once at creation time; only
// the SHA-256 hash is stored, so a leaked DB dump cannot mint keys. Bootstrap
// service keys (env-provided, e.g. the APISIX consumer key) are upserted into
// the same table at startup so the gateway keeps working unchanged.
//
// Scopes is a comma-separated subset of {tasks,scripts,internal} restricting
// which service groups the key may call (empty = all, legacy/bootstrap rows).
// RatePerMin caps requests per minute for the key (0 = unlimited).
type APIKey struct {
	ID         int64      `gorm:"primaryKey;autoIncrement" json:"-"`
	KeyID      string     `gorm:"column:key_id;uniqueIndex;size:64;not null" json:"key_id"`
	Name       string     `gorm:"column:name;uniqueIndex;size:64;not null" json:"name"`
	KeyHash    string     `gorm:"column:key_hash;uniqueIndex;size:64;not null" json:"-"`
	KeyPrefix  string     `gorm:"column:key_prefix;size:16;not null" json:"key_prefix"`        // display only (first chars of the plaintext)
	Scopes     string     `gorm:"column:scopes;size:64;not null;default:" json:"scopes"`       // tasks / scripts / internal (CSV)
	RatePerMin int        `gorm:"column:rate_per_min;not null;default:0" json:"rate_per_min"`  // requests/min cap, 0 = unlimited
	Status     string     `gorm:"column:status;size:16;default:active;not null" json:"status"` // active / revoked
	CreatedBy  string     `gorm:"column:created_by;size:64" json:"created_by"`
	LastUsedAt *time.Time `gorm:"column:last_used_at" json:"last_used_at,omitempty"`
	ExpiresAt  *time.Time `gorm:"column:expires_at" json:"expires_at,omitempty"`
	CreatedAt  time.Time  `gorm:"column:created_at;autoCreateTime" json:"created_at"`
}

func (APIKey) TableName() string { return "api_key" }

// Secret is a stored credential (e.g. a third-party service API key) that
// Lua scripts reference by name via ctx.secret(name). Values are
// AES-256-GCM encrypted at rest (SECURITY__API_KEY_ENCRYPTION_KEY, same
// format as the main app/app-auth); plaintext is never rendered back —
// secrets are write-only from the console.
type Secret struct {
	ID          int64     `gorm:"primaryKey;autoIncrement" json:"-"`
	SecretID    string    `gorm:"column:secret_id;uniqueIndex;size:36" json:"secret_id"` // UUID identifier (int64 PK stays internal; legacy rows backfilled at startup)
	Name        string    `gorm:"column:name;uniqueIndex;size:64;not null" json:"name"`
	Description string    `gorm:"column:description;size:255" json:"description"`
	ValueEnc    string    `gorm:"column:value_enc;type:text;not null" json:"-"`
	CreatedBy   string    `gorm:"column:created_by;size:64" json:"created_by"`
	UpdatedBy   string    `gorm:"column:updated_by;size:64" json:"updated_by"`
	CreatedAt   time.Time `gorm:"column:created_at;autoCreateTime" json:"created_at"`
	UpdatedAt   time.Time `gorm:"column:updated_at;autoUpdateTime" json:"updated_at"`
}

func (Secret) TableName() string { return "secret" }

// ClusterNode is one app-task instance's registration in the node roster:
// heartbeats prove liveness, stale heartbeats mark the node dead and let the
// survivors take over its dispatching claims immediately (instead of waiting
// out the per-claim TTL). Liveness is COMPUTED from last_heartbeat, never
// stored.
type ClusterNode struct {
	ID       int64  `gorm:"primaryKey;autoIncrement" json:"-"`
	NodeID   string `gorm:"column:node_id;uniqueIndex;size:64;not null" json:"node_id"`
	Hostname string `gorm:"column:hostname;size:128" json:"hostname,omitempty"`
	Version  string `gorm:"column:version;size:32" json:"version,omitempty"`
	Weight   int    `gorm:"column:weight;default:1;not null" json:"weight"` // dispatch share (scheduler.weight)
	// State: active (heartbeat-registered member) / pending_join (pre-registered
	// via the console/CLI join flow, awaiting the node's first heartbeat).
	State         string    `gorm:"column:state;size:16;default:active;not null" json:"state"`
	JoinedVia     string    `gorm:"column:joined_via;size:16" json:"joined_via,omitempty"` // auto / cli / web
	InvitedBy     string    `gorm:"column:invited_by;size:64" json:"invited_by,omitempty"` // operator who pre-registered the node
	StartedAt     time.Time `gorm:"column:started_at" json:"started_at"`
	LastHeartbeat time.Time `gorm:"column:last_heartbeat;index" json:"last_heartbeat"`
	CreatedAt     time.Time `gorm:"column:created_at;autoCreateTime" json:"created_at"`
	UpdatedAt     time.Time `gorm:"column:updated_at;autoUpdateTime" json:"updated_at"`
}

func (ClusterNode) TableName() string { return "cluster_node" }
