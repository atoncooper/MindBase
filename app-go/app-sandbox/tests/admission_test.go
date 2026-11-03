package tests

import (
	. "app-sandbox/internal/service"
	"context"
	"errors"
	"testing"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/runtime"
)

func TestAdmissionGrantsAndReleases(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Admission.MaxConcurrent = 2
		cfg.Admission.MaxPerUID = 2
		cfg.Admission.QueueSize = 2
	})
	release1, err := env.admission.Acquire(context.Background(), 1)
	if err != nil {
		t.Fatalf("acquire 1: %v", err)
	}
	release2, err := env.admission.Acquire(context.Background(), 2)
	if err != nil {
		t.Fatalf("acquire 2: %v", err)
	}
	if global, _ := env.admission.Stats(); global != 2 {
		t.Fatalf("global = %d, want 2", global)
	}
	release1()
	release2()
	if global, queued := env.admission.Stats(); global != 0 || queued != 0 {
		t.Fatalf("after release = (%d,%d), want (0,0)", global, queued)
	}
}

func TestAdmissionQueueFullReturnsQueueFull(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Admission.MaxConcurrent = 1
		cfg.Admission.MaxPerUID = 1
		cfg.Admission.QueueSize = 0 // no queue at all
	})
	release, err := env.admission.Acquire(context.Background(), 1)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	defer release()
	if _, err := env.admission.Acquire(context.Background(), 1); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("want ErrQueueFull, got %v", err)
	}
}

func TestAdmissionQueueTimeoutReturnsQueueTimeout(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Admission.MaxConcurrent = 1
		cfg.Admission.MaxPerUID = 1
		cfg.Admission.QueueSize = 4
		cfg.Admission.QueueTimeoutMS = 30
	})
	release, err := env.admission.Acquire(context.Background(), 1)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	defer release()
	start := time.Now()
	if _, err := env.admission.Acquire(context.Background(), 2); !errors.Is(err, ErrQueueTimeout) {
		t.Fatalf("want ErrQueueTimeout, got %v", err)
	}
	if elapsed := time.Since(start); elapsed < 20*time.Millisecond {
		t.Fatalf("queue timeout returned too early: %v", elapsed)
	}
}

func TestAdmissionQueuedRequestIsGrantedOnRelease(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Admission.MaxConcurrent = 1
		cfg.Admission.MaxPerUID = 1
		cfg.Admission.QueueSize = 4
		cfg.Admission.QueueTimeoutMS = 2000
	})
	first, err := env.admission.Acquire(context.Background(), 1)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	secondRelease := make(chan func(), 1)
	go func() {
		release, aerr := env.admission.Acquire(context.Background(), 2)
		if aerr != nil {
			secondRelease <- nil
			return
		}
		secondRelease <- release
	}()
	// Let the goroutine enqueue, then free the slot.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, queued := env.admission.Stats(); queued == 1 {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	first()
	select {
	case release := <-secondRelease:
		if release == nil {
			t.Fatal("queued acquire failed instead of being granted")
		}
		release()
	case <-time.After(2 * time.Second):
		t.Fatal("queued acquire was never granted")
	}
}

func TestAdmissionRespectsPerUIDCap(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Admission.MaxConcurrent = 4
		cfg.Admission.MaxPerUID = 1
		cfg.Admission.QueueSize = 0
	})
	release, err := env.admission.Acquire(context.Background(), 5)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	defer release()
	if _, err := env.admission.Acquire(context.Background(), 5); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("same uid over per-uid cap: want ErrQueueFull, got %v", err)
	}
}
