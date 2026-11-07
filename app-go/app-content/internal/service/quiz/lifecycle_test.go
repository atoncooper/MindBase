package service

import "testing"

// 超时清扫的终态决策：checkpoint 有题 → partial（可练），无题/未知 → failed。
func TestStatusForTimedGeneration(t *testing.T) {
	if status, msg := statusForTimedGeneration(7); status != "partial" || msg == "" {
		t.Fatalf("count>0 should be partial, got %s / %s", status, msg)
	}
	if status, _ := statusForTimedGeneration(0); status != "failed" {
		t.Fatalf("count=0 should be failed, got %s", status)
	}
	if status, _ := statusForTimedGeneration(-1); status != "failed" {
		t.Fatalf("mongo unavailable (-1) should fail safe, got %s", status)
	}
}
