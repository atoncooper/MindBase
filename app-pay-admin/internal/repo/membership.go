// Package repo: membership + entitlement-event queries over pay_membership /
// pay_membership_event.
package repo

import (
	"app-pay-admin/internal/db"
	"app-pay-admin/internal/model"
)

// GetMembershipByUID resolves one membership by its unique uid (nil if absent).
func GetMembershipByUID(uid int64) (*model.PayMembership, error) {
	var m model.PayMembership
	err := db.DB.Where("uid = ?", uid).First(&m).Error
	if isNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// ListMemberships returns one page of memberships (newest first, PK order;
// only the uid unique index exists, so full listing relies on the PK scan —
// admin-scale row counts keep this bounded).
func ListMemberships(limit, offset int) ([]model.PayMembership, int64, error) {
	q := db.DB.Model(&model.PayMembership{})
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var ms []model.PayMembership
	err := q.Order("id DESC").Limit(limit).Offset(offset).Find(&ms).Error
	if err != nil {
		return nil, 0, err
	}
	return ms, total, nil
}

// EventFilter selects entitlement events (uid exact via
// idx_pay_membership_event_uid when set; type is a secondary filter).
type EventFilter struct {
	UID    int64
	UIDSet bool
	Type   string
	Limit  int
	Offset int
}

// ListEvents returns one page of entitlement events, newest first.
func ListEvents(f EventFilter) ([]model.PayMembershipEvent, int64, error) {
	q := db.DB.Model(&model.PayMembershipEvent{})
	if f.UIDSet {
		q = q.Where("uid = ?", f.UID)
	}
	if f.Type != "" {
		q = q.Where("type = ?", f.Type)
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var evs []model.PayMembershipEvent
	err := q.Order("id DESC").Limit(f.Limit).Offset(f.Offset).Find(&evs).Error
	if err != nil {
		return nil, 0, err
	}
	return evs, total, nil
}

// ListEventsByUID is the per-member event stream (idx_pay_membership_event_uid).
func ListEventsByUID(uid int64, limit, offset int) ([]model.PayMembershipEvent, int64, error) {
	return ListEvents(EventFilter{UID: uid, UIDSet: true, Limit: limit, Offset: offset})
}
