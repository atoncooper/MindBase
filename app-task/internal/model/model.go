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
//   pending -> running (async accepted) -> completed | failed
//   pending -> completed (sync success)
//   failed/any -> pending (retry with next_retry_at)
type Task struct {
	ID           int64          `gorm:"primaryKey;autoIncrement" json:"-"`
	TaskID        string         `gorm:"column:task_id;uniqueIndex;size:64;not null" json:"task_id"`
	UID          int64          `gorm:"column:uid;index;not null" json:"uid"` // owner
	TaskType      string         `gorm:"column:task_type;size:32;default:http;not null" json:"task_type"` // http (default) / lua / ...
	Payload      datatypes.JSON `gorm:"column:payload;type:json" json:"payload,omitempty"`             // opaque task parameters, passed to the executor verbatim
	ExecutorURL  string         `gorm:"column:executor_url;size:512" json:"executor_url,omitempty"`    // http mode: third-party executor endpoint
	Async        bool           `gorm:"column:async;not null" json:"async"`                            // true: executor replies 202 and reports via callback
	CronExpr     string         `gorm:"column:cron_expr;size:64" json:"cron_expr,omitempty"`           // 5-field cron; empty = one-shot
	CronNextTaskID string        `gorm:"column:cron_next_task_id;size:64" json:"cron_next_task_id,omitempty"` // next occurrence (dedupe)
	TriggerTime  time.Time      `gorm:"column:trigger_time;not null;index:ix_task_status_trigger,priority:2" json:"trigger_time"`
	Status       string         `gorm:"column:status;size:20;default:pending;not null;index:ix_task_status_trigger,priority:1;index:ix_task_status_next_retry,priority:1" json:"status"`
	MaxRetry     int            `gorm:"column:max_retry;default:0;not null" json:"max_retry"`         // 0 = no retry
	RetryCount   int            `gorm:"column:retry_count;default:0;not null" json:"retry_count"`
	NextRetryAt  *time.Time     `gorm:"column:next_retry_at;index:ix_task_status_next_retry,priority:2" json:"next_retry_at,omitempty"`
	Weight       int            `gorm:"column:weight;default:1;not null" json:"weight"`               // WFQ weight (reserved, M4)
	LastResult   *string        `gorm:"column:last_result;type:text" json:"last_result,omitempty"`    // short outcome summary from the last execution
	CreatedAt    time.Time      `gorm:"column:created_at;autoCreateTime" json:"created_at"`
	UpdatedAt    time.Time      `gorm:"column:updated_at;autoUpdateTime" json:"updated_at"`
}

func (Task) TableName() string { return "task" }

// TaskLog is the audit trail of every trigger/execution: which task, which
// executor, what was sent/received, outcome and duration. This is the
// scheduler's only record of what happened (溯源).
type TaskLog struct {
	ID         int64     `gorm:"primaryKey;autoIncrement" json:"-"`
	LogID      string    `gorm:"column:log_id;uniqueIndex;size:64;not null" json:"log_id"`
	TaskID      string    `gorm:"column:task_id;index:ix_task_log_task_id;size:64;not null" json:"task_id"`
	TriggerAt  time.Time `gorm:"column:trigger_at;autoCreateTime" json:"trigger_at"`
	Executor   string    `gorm:"column:executor;size:512" json:"executor,omitempty"` // executor_url or "lua:<script_id>"
	Request    string    `gorm:"column:request;type:text" json:"request,omitempty"`  // payload (truncated)
	Response   string    `gorm:"column:response;type:text" json:"response,omitempty"`
	Status     string    `gorm:"column:status;size:16;not null" json:"status"`       // success / failed / timeout / retry
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
	ReferenceID string         `gorm:"column:reference_id;size:64;index" json:"reference_id,omitempty"` // business correlation id (audit/idempotency)
	Status      string         `gorm:"column:status;size:20;default:pending;not null;index:ix_email_queue_status_next_retry,priority:1" json:"status"` // pending / sent / failed / dry_run
	RetryCount  int            `gorm:"column:retry_count;default:0;not null" json:"retry_count"`
	NextRetryAt *time.Time     `gorm:"column:next_retry_at;index:ix_email_queue_status_next_retry,priority:2" json:"next_retry_at,omitempty"`
	LastError   *string        `gorm:"column:last_error;type:text" json:"last_error,omitempty"`
	CreatedAt   time.Time      `gorm:"column:created_at;autoCreateTime" json:"created_at"`
	SentAt      *time.Time     `gorm:"column:sent_at" json:"sent_at,omitempty"`
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
	ID           int64     `gorm:"primaryKey;autoIncrement" json:"id"`
	Username     string    `gorm:"column:username;uniqueIndex;size:64;not null" json:"username"`
	PasswordHash string    `gorm:"column:password_hash;size:255;not null" json:"-"`
	Role         string    `gorm:"column:role;size:16;default:member;not null" json:"role"` // admin / member
	CreatedAt    time.Time `gorm:"column:created_at;autoCreateTime" json:"created_at"`
}

func (WebUIUser) TableName() string { return "webui_user" }
