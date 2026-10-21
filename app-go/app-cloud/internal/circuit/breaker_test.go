package circuit

import (
	"errors"
	"testing"
	"time"
)

func TestBreakerTripsAndFastFails(t *testing.T) {
	b := New(3, 50*time.Millisecond)
	for i := 0; i < 3; i++ {
		if !b.Allow() {
			t.Fatal("closed breaker must allow")
		}
		b.OnFailure()
	}
	if b.Allow() {
		t.Fatal("breaker must be open after threshold failures")
	}
	// elapsed cooldown → half-open probe allowed
	time.Sleep(60 * time.Millisecond)
	if !b.Allow() {
		t.Fatal("half-open probe must be allowed after cooldown")
	}
	// failed probe re-arms the cooldown → fast-fail again
	b.OnFailure()
	if b.Allow() {
		t.Fatal("failed probe must re-arm the open state")
	}
}

func TestBreakerSuccessCloses(t *testing.T) {
	b := New(2, 10*time.Millisecond)
	b.OnFailure()
	b.OnFailure()
	time.Sleep(20 * time.Millisecond)
	if !b.Allow() {
		t.Fatal("probe expected")
	}
	b.OnSuccess()
	if b.Allow() != true {
		t.Fatal("closed again")
	}
	for i := 0; i < 10; i++ {
		if !b.Allow() {
			t.Fatal("success must reset the failure count")
		}
	}
}

func TestBreakerErrOpenSentinel(t *testing.T) {
	if !errors.Is(ErrOpen, ErrOpen) {
		t.Fatal("sentinel must be wrappable")
	}
}
