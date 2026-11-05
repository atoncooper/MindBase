package tests

// Content-review disclosure guards: the second, SEPARATE acknowledgment must
// stay backend-enforced at creation time and must never silently reuse the
// legacy legalAck.

import (
	"testing"

	"app-cloud/internal/service"
)

func TestContentReviewAckErrorCopy(t *testing.T) {
	if service.ErrContentReviewAckRequired.Error() != "请单独确认管理员内容审核告知" {
		t.Fatalf("content review ack copy drifted: %q", service.ErrContentReviewAckRequired.Error())
	}
	if service.ErrContentReviewAckRequired == service.ErrLegalAckRequired {
		t.Fatal("the two acknowledgments must be distinct errors")
	}
}

func TestContentReviewPolicyVersionPinned(t *testing.T) {
	if service.ContentReviewPolicyVersion == "" {
		t.Fatal("policy version must not be empty — ack rows must be traceable to a wording version")
	}
}
