// Package model holds the five GORM tables owned by app-sandbox. The runtime
// (container/execd) is the source of truth for a sandbox; the database only
// stores leases, executions, artifact metadata, daily usage counters and the
// audit trail. AutoMigrate touches these tables only (see internal/db).
package model

import "time"

// Lease states: creating -> ready -> busy -> idle -> releasing -> terminated,
// with failed as the terminal error state (reclaimed by the sweeper).
const (
	LeaseStateCreating   = "creating"
	LeaseStateReady      = "ready"
	LeaseStateBusy       = "busy"
	LeaseStateIdle       = "idle"
	LeaseStateReleasing  = "releasing"
	LeaseStateTerminated = "terminated"
	LeaseStateFailed     = "failed"
)

// LeaseActiveStates count against the per-uid concurrency quota.
var LeaseActiveStates = []string{LeaseStateCreating, LeaseStateReady, LeaseStateBusy, LeaseStateIdle}

// LeaseReusableStates can serve another execution of the same spec.
var LeaseReusableStates = []string{LeaseStateReady, LeaseStateIdle}

// LeaseFinishedStates are terminal and no longer hold runtime capacity.
var LeaseFinishedStates = []string{LeaseStateTerminated, LeaseStateFailed}

// Execution states.
const (
	ExecStatusQueued    = "queued"
	ExecStatusRunning   = "running"
	ExecStatusSucceeded = "succeeded"
	ExecStatusFailed    = "failed"
	ExecStatusTimeout   = "timeout"
	ExecStatusCanceled  = "canceled"
)

// ExecTerminalStates are the states in which an execution can no longer change.
var ExecTerminalStates = []string{ExecStatusSucceeded, ExecStatusFailed, ExecStatusTimeout, ExecStatusCanceled}

// ExecActiveStates are the non-terminal states.
var ExecActiveStates = []string{ExecStatusQueued, ExecStatusRunning}

// Audit actions.
const (
	AuditExecutionCreate = "execution.create"
	AuditExecutionStart  = "execution.start"
	AuditExecutionFinish = "execution.finish"
	AuditExecutionCancel = "execution.cancel"
	AuditExecutionDeny   = "execution.deny"
	AuditLeaseCreate     = "lease.create"
	AuditLeaseReuse      = "lease.reuse"
	AuditLeaseRelease    = "lease.release"
	AuditArtifactUpload  = "artifact.upload"
	AuditArtifactDeny    = "artifact.deny"
)

// SandboxLease is one reusable sandbox instance tied to a spec identity.
// Unique identity for reuse: (uid, project_id, purpose, spec_hash).
type SandboxLease struct {
	ID         string    `gorm:"column:id;type:varchar(36);primaryKey" json:"id"`
	UID        int64     `gorm:"column:uid;index:idx_lease_uid_state,priority:1" json:"uid"`
	ProjectID  string    `gorm:"column:project_id;type:varchar(64);not null;default:''" json:"projectId"`
	Purpose    string    `gorm:"column:purpose;type:varchar(32);not null;default:''" json:"purpose"`
	Runtime    string    `gorm:"column:runtime;type:varchar(16);not null;default:''" json:"runtime"`
	RuntimeID  string    `gorm:"column:runtime_id;type:varchar(128);not null;default:''" json:"runtimeId"`
	SpecHash   string    `gorm:"column:spec_hash;type:varchar(64);not null;default:''" json:"specHash"`
	State      string    `gorm:"column:state;type:varchar(16);index:idx_lease_uid_state,priority:2" json:"state"`
	ExpiresAt  time.Time `gorm:"column:expires_at;index:idx_lease_expires" json:"expiresAt"`
	LastUsedAt time.Time `gorm:"column:last_used_at" json:"lastUsedAt"`
	CreatedAt  time.Time `gorm:"column:created_at;index:idx_lease_created_at" json:"createdAt"`
}

func (SandboxLease) TableName() string { return "sandbox_lease" }

// SandboxExecution is one code run against a lease. The code body is NOT
// stored: code_sha256 plus the truncated stdout/stderr previews are enough for
// audit and for polling clients.
type SandboxExecution struct {
	ID             string     `gorm:"column:id;type:varchar(36);primaryKey" json:"id"`
	LeaseID        string     `gorm:"column:lease_id;type:varchar(36);not null;default:'';index:idx_execution_lease" json:"leaseId"`
	UID            int64      `gorm:"column:uid;index:idx_execution_uid_created,priority:1" json:"uid"`
	ProjectID      string     `gorm:"column:project_id;type:varchar(64);not null;default:''" json:"projectId"`
	Purpose        string     `gorm:"column:purpose;type:varchar(32);not null;default:''" json:"purpose"`
	Language       string     `gorm:"column:language;type:varchar(16);not null;default:''" json:"language"`
	CodeSHA256     string     `gorm:"column:code_sha256;type:char(64);not null;default:''" json:"codeSha256"`
	Status         string     `gorm:"column:status;type:varchar(16);not null;default:'queued';index:idx_execution_status,priority:1" json:"status"`
	ExitCode       *int       `gorm:"column:exit_code" json:"exitCode,omitempty"`
	TimeoutMS      int        `gorm:"column:timeout_ms;not null;default:0" json:"timeoutMs"`
	StdoutBytes    int64      `gorm:"column:stdout_bytes;not null;default:0" json:"stdoutBytes"`
	StderrBytes    int64      `gorm:"column:stderr_bytes;not null;default:0" json:"stderrBytes"`
	StdoutPreview  string     `gorm:"column:stdout_preview;type:text" json:"stdoutPreview,omitempty"`
	StderrPreview  string     `gorm:"column:stderr_preview;type:text" json:"stderrPreview,omitempty"`
	ArtifactPrefix string     `gorm:"column:artifact_prefix;type:varchar(255);not null;default:''" json:"artifactPrefix"`
	ErrorCode      string     `gorm:"column:error_code;type:varchar(64);not null;default:''" json:"errorCode,omitempty"`
	StartedAt      *time.Time `gorm:"column:started_at" json:"startedAt,omitempty"`
	// DeadlineAt = started_at + timeout_ms, kept as a column so the sweeper's
	// "running too long" query is a plain index range scan (no date math).
	DeadlineAt *time.Time `gorm:"column:deadline_at;index:idx_execution_deadline" json:"deadlineAt,omitempty"`
	FinishedAt *time.Time `gorm:"column:finished_at" json:"finishedAt,omitempty"`
	CreatedAt  time.Time  `gorm:"column:created_at;index:idx_execution_uid_created,priority:2;index:idx_execution_created_at" json:"createdAt"`
}

func (SandboxExecution) TableName() string { return "sandbox_execution" }

// SandboxArtifact is the metadata row of one collected output file. The bytes
// live in object storage (MinIO); object_key is the storage key.
type SandboxArtifact struct {
	ID          string    `gorm:"column:id;type:varchar(36);primaryKey" json:"id"`
	ExecutionID string    `gorm:"column:execution_id;type:varchar(36);not null;index:idx_artifact_execution" json:"executionId"`
	UID         int64     `gorm:"column:uid;index:idx_artifact_uid" json:"uid"`
	Name        string    `gorm:"column:name;type:varchar(255);not null;default:''" json:"name"`
	ObjectKey   string    `gorm:"column:object_key;type:varchar(512);not null;default:''" json:"objectKey"`
	SizeBytes   int64     `gorm:"column:size_bytes;not null;default:0" json:"sizeBytes"`
	SHA256      string    `gorm:"column:sha256;type:char(64);not null;default:''" json:"sha256"`
	ContentType string    `gorm:"column:content_type;type:varchar(128);not null;default:''" json:"contentType"`
	CreatedAt   time.Time `gorm:"column:created_at" json:"createdAt"`
}

func (SandboxArtifact) TableName() string { return "sandbox_artifact" }

// SandboxUsageDaily is the per-uid daily quota ledger. Day is the business-local
// date (YYYY-MM-DD, config.timezone) so quotas reset at local midnight.
type SandboxUsageDaily struct {
	UID           int64     `gorm:"column:uid;primaryKey" json:"uid"`
	Day           string    `gorm:"column:day;type:char(10);primaryKey" json:"day"`
	Executions    int64     `gorm:"column:executions;not null;default:0" json:"executions"`
	CPUMillis     int64     `gorm:"column:cpu_millis;not null;default:0" json:"cpuMillis"`
	ArtifactBytes int64     `gorm:"column:artifact_bytes;not null;default:0" json:"artifactBytes"`
	LeasesCreated int64     `gorm:"column:leases_created;not null;default:0" json:"leasesCreated"`
	UpdatedAt     time.Time `gorm:"column:updated_at" json:"updatedAt"`
}

func (SandboxUsageDaily) TableName() string { return "sandbox_usage_daily" }

// SandboxAudit is the append-only audit trail (create/exec/release/deny/...).
// Detail is a short human-readable note; code bodies never land here.
type SandboxAudit struct {
	ID          string `gorm:"column:id;type:varchar(36);primaryKey" json:"id"`
	UID         int64  `gorm:"column:uid;index:idx_audit_uid_created,priority:1" json:"uid"`
	Action      string `gorm:"column:action;type:varchar(32);index:idx_audit_action" json:"action"`
	ExecutionID string `gorm:"column:execution_id;type:varchar(36);not null;default:'';index:idx_audit_execution" json:"executionId"`
	LeaseID     string `gorm:"column:lease_id;type:varchar(36);not null;default:''" json:"leaseId"`
	ProjectID   string `gorm:"column:project_id;type:varchar(64);not null;default:''" json:"projectId"`
	Image       string `gorm:"column:image;type:varchar(255);not null;default:''" json:"image"`
	Outcome     string `gorm:"column:outcome;type:varchar(32);not null;default:''" json:"outcome"`
	DurationMS  int64  `gorm:"column:duration_ms;not null;default:0" json:"durationMs"`
	ExitCode    *int   `gorm:"column:exit_code" json:"exitCode,omitempty"`
	Detail      string `gorm:"column:detail;type:varchar(512);not null;default:''" json:"detail"`
	RequestID   string `gorm:"column:request_id;type:varchar(64);not null;default:''" json:"requestId"`
	// Actor is "agent" | "user" | "system" | "admin" — who caused the audited
	// action (admin writes always record "admin"; pre-1.0.19 rows are "").
	Actor     string    `gorm:"column:actor;type:varchar(16);not null;default:''" json:"actor"`
	CreatedAt time.Time `gorm:"column:created_at;index:idx_audit_uid_created,priority:2;index:idx_audit_created_at" json:"createdAt"`
}

func (SandboxAudit) TableName() string { return "sandbox_audit" }

// IsExecTerminal reports whether an execution status is final.
func IsExecTerminal(status string) bool {
	for _, s := range ExecTerminalStates {
		if s == status {
			return true
		}
	}
	return false
}
