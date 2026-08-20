package executor

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestRegistryBasics(t *testing.T) {
	r := NewRegistry()
	if len(r.Types()) != 0 {
		t.Fatal("new registry must be empty")
	}
	called := false
	r.Register("push", func(ctx context.Context, task Task) error {
		called = true
		return nil
	})
	h, ok := r.Handler("push")
	if !ok {
		t.Fatal("registered handler not found")
	}
	if err := h(context.Background(), Task{}); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("handler was not invoked")
	}
	if _, ok := r.Handler("missing"); ok {
		t.Fatal("unregistered type resolved")
	}
}

func TestRegistryReplaceAndSortedTypes(t *testing.T) {
	r := NewRegistry()
	r.Register("b", func(ctx context.Context, task Task) error { return nil })
	r.Register("a", func(ctx context.Context, task Task) error { return nil })
	r.Register("b", func(ctx context.Context, task Task) error { return errors.New("replaced") })
	types := r.Types()
	if len(types) != 2 || types[0] != "a" || types[1] != "b" {
		t.Fatalf("types = %v, want [a b]", types)
	}
	h, _ := r.Handler("b")
	if err := h(context.Background(), Task{}); err == nil {
		t.Fatal("replacement handler not effective")
	}
}

// The sentinel errors must be distinguishable so the scheduler can treat
// async/retry differently from hard failures.
func TestSentinelErrors(t *testing.T) {
	if errors.Is(ErrAsync, ErrRetry) {
		t.Fatal("ErrAsync must differ from ErrRetry")
	}
	if !errors.Is(fmt.Errorf("wrap: %w", ErrAsync), ErrAsync) {
		t.Fatal("wrapped ErrAsync must be detectable")
	}
}
