package tests

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/service"
)

func admissionConfig(maxConcurrent, maxMemory int64, queueSize int) *config.Config {
	return &config.Config{
		Runtime: config.RuntimeConfig{Resources: config.ResourceConfig{Memory: "256Mi"}},
		Admission: config.AdmissionConfig{
			MaxConcurrent:  int(maxConcurrent),
			MaxPerUID:      2,
			QueueSize:      queueSize,
			QueueTimeoutMS: 500,
			MaxMemoryBytes: maxMemory,
			Weights:        map[string]float64{"free": 1, "vip": 2, "svip": 4},
		},
	}
}

func TestAdmissionMemoryBudget(t *testing.T) {
	a := service.NewAdmission(admissionConfig(8, 512<<20, 0), nil)
	first, err := a.Acquire(context.Background(), 1)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	second, err := a.Acquire(context.Background(), 2)
	if err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	if _, err := a.Acquire(context.Background(), 3); !errors.Is(err, service.ErrQueueFull) {
		t.Fatalf("third acquire = %v, want queue full", err)
	}
	first()
	third, err := a.Acquire(context.Background(), 3)
	if err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
	second()
	third()
	if inUse, limit := a.MemoryStats(); inUse != 0 || limit != 512<<20 {
		t.Fatalf("memory stats = %d/%d", inUse, limit)
	}
}

func TestAdmissionWeightedFIFOGrantsHeavyFirst(t *testing.T) {
	cfg := admissionConfig(1, 0, 4)
	cfg.Admission.QueueTimeoutMS = 2000
	a := service.NewAdmission(cfg, nil)
	held, err := a.Acquire(context.Background(), 1)
	if err != nil {
		t.Fatalf("initial acquire: %v", err)
	}

	type result struct {
		name string
		err  error
	}
	var mu sync.Mutex
	var order []string
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		release, err := a.Acquire(context.Background(), 2, 1)
		mu.Lock()
		order = append(order, "low")
		mu.Unlock()
		if err == nil {
			release()
		}
	}()
	time.Sleep(50 * time.Millisecond)
	go func() {
		defer wg.Done()
		release, err := a.Acquire(context.Background(), 3, 4)
		mu.Lock()
		order = append(order, "high")
		mu.Unlock()
		if err == nil {
			release()
		}
	}()
	time.Sleep(100 * time.Millisecond)
	held()
	wg.Wait()
	if len(order) < 2 || order[0] != "high" {
		t.Fatalf("grant order = %v, want high first", order)
	}
}

func TestAdmissionWeightForTier(t *testing.T) {
	a := service.NewAdmission(admissionConfig(1, 0, 0), nil)
	if got := a.WeightForTier("svip"); got != 4 {
		t.Fatalf("svip weight = %v", got)
	}
	if got := a.WeightForTier("unknown"); got != 1 {
		t.Fatalf("unknown weight = %v", got)
	}
}
