package appops

import "context"

// ConfirmRefundOrReject dispatches approve/reject for the refund workbench.
// confirm=true  -> POST refund (confirm=true, operator=checker)
// confirm=false -> POST refund/reject (operator=checker)
func (c *Client) ConfirmRefundOrReject(ctx context.Context, orderNo, operator, reason string, confirm bool) error {
	if confirm {
		return c.ConfirmRefund(ctx, orderNo, operator, reason)
	}
	return c.RejectRefund(ctx, orderNo, operator)
}
