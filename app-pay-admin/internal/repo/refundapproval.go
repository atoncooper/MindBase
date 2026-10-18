// Package repo: 退款复核审批单读取（pay_refund_approval，V4 迁移）。
// 只读：approve/reject 的资金写经 app-pay 的 internal 端点执行，
// 本服务不直接改这张表（审计/状态机一致性）。
package repo

import (
	"app-pay-admin/internal/db"
	"app-pay-admin/internal/model"
)

// RefundApprovalFilter selects approval rows. status 为空 = 全部；
// status 过滤走 idx_pay_refund_approval_status (status, created_at)。
type RefundApprovalFilter struct {
	Status string
	Limit  int
	Offset int
}

// ListRefundApprovals returns one page of approvals, newest id first
// （单量 = 运营人工处理量级，id 倒序足够；status 走索引过滤）。
func ListRefundApprovals(f RefundApprovalFilter) ([]model.PayRefundApproval, int64, error) {
	q := db.DB.Model(&model.PayRefundApproval{})
	if f.Status != "" {
		q = q.Where("status = ?", f.Status)
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []model.PayRefundApproval
	err := q.Order("id DESC").Limit(f.Limit).Offset(f.Offset).Find(&rows).Error
	if err != nil {
		return nil, 0, err
	}
	return rows, total, nil
}
