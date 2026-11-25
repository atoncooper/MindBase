package model

import "time"

// CodingPlanDefault marks at most one plan per user as the chat default.
// Kept in a companion table so the live coding_plans schema stays CREATE-only.
type CodingPlanDefault struct {
	UID       int64      `gorm:"column:uid;primaryKey" json:"uid"`
	PlanID    int64      `gorm:"column:plan_id" json:"plan_id"`
	CreatedAt *time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt *time.Time `gorm:"column:updated_at" json:"updated_at"`
}

func (CodingPlanDefault) TableName() string { return "coding_plan_defaults" }
