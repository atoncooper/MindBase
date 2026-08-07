// Package model defines GORM models mirroring the main app's task_quiz_*
// tables. Schema is owned by the main app (app/models.py + system.sql);
// app-task only reads/writes. If you change a column here, also update
// app/models.py + app/system.sql to keep them in sync.
package model

import (
	"time"

	"gorm.io/datatypes"
)

// TaskQuizCollection is the MongoDB collection name (shared with main app).
const TaskQuizCollection = "task_quiz_questions"

// TaskQuizTask: scheduled quiz task. State machine: pending->generating->sent->completed|overdue|failed.
type TaskQuizTask struct {
	ID                int64          `gorm:"primaryKey;autoIncrement" json:"-"`
	TaskID            string         `gorm:"column:task_id;uniqueIndex;size:64;not null" json:"task_id"`
	UID               int64          `gorm:"column:uid;index;not null" json:"uid"`
	UserEmail         string         `gorm:"column:user_email;size:255;not null" json:"user_email"`
	CCEmails          datatypes.JSON `gorm:"column:cc_emails;type:json;not null" json:"cc_emails"`
	Prompt            string         `gorm:"column:prompt;size:500;not null" json:"prompt"`
	Difficulty        string         `gorm:"column:difficulty;size:20;default:medium;not null" json:"difficulty"` // easy/medium/hard (考研难度: 简单/中等/压轴)
	IncompleteMessage *string        `gorm:"column:incomplete_message;type:text" json:"incomplete_message,omitempty"`
	TriggerTime       time.Time      `gorm:"column:trigger_time;not null" json:"trigger_time"`
	Status            string         `gorm:"column:status;size:20;default:pending;not null" json:"status"`
	Deadline          *time.Time     `gorm:"column:deadline" json:"deadline,omitempty"` // new: for check_timeout polling
	XXLJobIDA         *string        `gorm:"column:xxl_job_id_a;size:64" json:"-"`      // retained, unused (legacy xxl-job)
	XXLJobIDB         *string        `gorm:"column:xxl_job_id_b;size:64" json:"-"`      // retained, unused (legacy xxl-job)
	CreatedAt         time.Time      `gorm:"column:created_at;autoCreateTime" json:"created_at"`
	UpdatedAt         time.Time      `gorm:"column:updated_at;autoUpdateTime" json:"updated_at"`
}

func (TaskQuizTask) TableName() string { return "task_quiz_task" }

// TaskQuizAnswer: user's answer to a quiz task.
type TaskQuizAnswer struct {
	ID          int64     `gorm:"primaryKey;autoIncrement" json:"-"`
	TaskID      string    `gorm:"column:task_id;index;not null" json:"task_id"`
	UID         int64     `gorm:"column:uid;index;not null" json:"uid"`
	Answer      string    `gorm:"column:answer;type:text;not null" json:"answer"`
	IsCorrect   bool      `gorm:"column:is_correct;not null" json:"is_correct"`
	SubmittedAt time.Time `gorm:"column:submitted_at;autoCreateTime" json:"submitted_at"`
}

func (TaskQuizAnswer) TableName() string { return "task_quiz_answer" }

// TaskQuizNotification: email queue + retry state.
type TaskQuizNotification struct {
	ID             int64          `gorm:"primaryKey;autoIncrement" json:"-"`
	NotificationID string         `gorm:"column:notification_id;uniqueIndex;size:64;not null" json:"notification_id"`
	TaskID         string         `gorm:"column:task_id;index;not null" json:"task_id"`
	Type           string         `gorm:"column:type;size:20;not null" json:"type"`
	Recipient      string         `gorm:"column:recipient;size:255;not null" json:"recipient"`
	CCEmails       datatypes.JSON `gorm:"column:cc_emails;type:json" json:"cc_emails"`
	Subject        string         `gorm:"column:subject;size:255;not null" json:"subject"`
	BodyHTML       string         `gorm:"column:body_html;type:text;not null" json:"body_html"`
	Status         string         `gorm:"column:status;size:20;default:pending;not null" json:"status"`
	RetryCount     int            `gorm:"column:retry_count;default:0;not null" json:"retry_count"`
	LastError      *string        `gorm:"column:last_error;type:text" json:"last_error,omitempty"`
	CreatedAt      time.Time      `gorm:"column:created_at;autoCreateTime" json:"created_at"`
	SentAt         *time.Time     `gorm:"column:sent_at" json:"sent_at,omitempty"`
}

func (TaskQuizNotification) TableName() string { return "task_quiz_notification" }
