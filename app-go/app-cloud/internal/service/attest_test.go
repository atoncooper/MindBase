package service

import (
	"bytes"
	"testing"
	"time"
)

// P0-2 regression: challenges/tickets are stateless HMACs — every replica
// must verify what any other replica issued. Identical shared secrets make
// that exact; boot-random keys make it impossible (documents why the shared
// secret is mandatory for multi-instance deployments).
func TestDeviceAttestorSharedSecretCrossInstance(t *testing.T) {
	shared := bytes.Repeat([]byte("mindbase-attest-shared-secret!"), 2) // >= 32 bytes
	a := NewDeviceAttestor(shared)
	b := NewDeviceAttestor(shared)
	token := "tok"
	now := time.Now()

	// challenge issued by a, verified by b (nginx routed the attest call to replica b)
	ch := a.Issue(token, now)
	if !b.VerifyChallenge(token, ch, now.Add(time.Second)) {
		t.Fatal("replica b rejected a challenge issued by replica a (shared secret broken)")
	}

	// ticket issued by b, verified by a on the access call
	fp := "0123456789abcdef0123456789abcdef"
	tk := b.IssueTicket(token, fp, now)
	if !a.VerifyTicket(token, fp, tk, now.Add(time.Second)) {
		t.Fatal("replica a rejected a ticket issued by replica b (shared secret broken)")
	}

	// a different secret must not verify (secret rotation / foreign deployment)
	c := NewDeviceAttestor(bytes.Repeat([]byte("other-secret-other-secret-other-s"), 2))
	if c.VerifyChallenge(token, ch, now.Add(time.Second)) {
		t.Fatal("challenge verified under a different secret")
	}
}

func TestDeviceAttestorBootRandomIsolated(t *testing.T) {
	a := NewDeviceAttestor(nil)
	b := NewDeviceAttestor(nil)
	ch := a.Issue("tok", time.Now())
	if b.VerifyChallenge("tok", ch, time.Now().Add(time.Second)) {
		t.Fatal("boot-random secrets must not cross-verify (documents the multi-replica breakage the shared secret fixes)")
	}
}

func TestDeviceAttestorExpiryAndTokenBinding(t *testing.T) {
	a := NewDeviceAttestor(bytes.Repeat([]byte("mindbase-attest-shared-secret!"), 2))
	now := time.Now()
	ch := a.Issue("tok", now)
	if a.VerifyChallenge("tok", ch, now.Add(ChallengeTTL+time.Second)) {
		t.Fatal("expired challenge accepted")
	}
	if a.VerifyChallenge("other", ch, now.Add(time.Second)) {
		t.Fatal("challenge accepted for a different share token")
	}
}
