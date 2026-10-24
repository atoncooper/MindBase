// Content-review disclosure guards (Issue #154): the second, SEPARATE
// acknowledgment must stay backend-enforced at CREATION time and must never
// silently reuse the legacy legalAck. Reviewer previews are NOT gated on it:
// moderation may need to inspect legacy / revoked / expired shares.
package service

import "testing"

func TestContentReviewAckErrorCopy(t *testing.T) {
	if ErrContentReviewAckRequired.Error() != "请单独确认管理员内容审核告知" {
		t.Fatalf("content review ack copy drifted: %q", ErrContentReviewAckRequired.Error())
	}
	if ErrContentReviewAckRequired == ErrLegalAckRequired {
		t.Fatal("the two acknowledgments must be distinct errors")
	}
}

func TestContentReviewPolicyVersionPinned(t *testing.T) {
	if ContentReviewPolicyVersion == "" {
		t.Fatal("policy version must not be empty — ack rows must be traceable to a wording version")
	}
}
