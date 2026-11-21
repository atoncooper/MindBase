package tests

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	cachelocal "app-cloud/internal/infra/cache/local"
)

type cacheTestValue struct {
	ID   int
	Name string
}

func TestCacheLocalGetSetTTL(t *testing.T) {
	c := cachelocal.New[string, cacheTestValue](cachelocal.WithDefaultTTL(time.Second))
	defer c.Close()
	ctx := context.Background()

	if _, ok := c.Get(ctx, "missing"); ok {
		t.Fatal("missing key should miss")
	}
	want := cacheTestValue{ID: 1, Name: "root"}
	c.Set(ctx, "a", want, 50*time.Millisecond)
	if got, ok := c.Get(ctx, "a"); !ok || got != want {
		t.Fatalf("Get = %+v,%v, want %+v,true", got, ok, want)
	}

	time.Sleep(80 * time.Millisecond)
	if _, ok := c.Get(ctx, "a"); ok {
		t.Fatal("expired key should miss")
	}
	if got := c.Len(); got != 0 {
		t.Fatalf("Len after expiry = %d, want 0", got)
	}
}

func TestCacheLocalGetOrLoadCoalescesConcurrentMisses(t *testing.T) {
	c := cachelocal.New[int64, string]()
	defer c.Close()
	ctx := context.Background()

	var calls atomic.Int32
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	loader := func(context.Context, int64) (string, error) {
		calls.Add(1)
		started <- struct{}{}
		<-release
		return "vip", nil
	}

	const workers = 8
	var wg sync.WaitGroup
	results := make([]string, workers)
	errs := make([]error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = c.GetOrLoad(ctx, 42, time.Minute, 0, loader)
		}(i)
	}

	<-started
	close(release)
	wg.Wait()

	if got := calls.Load(); got != 1 {
		t.Fatalf("loader calls = %d, want 1 single flight", got)
	}
	for i := range results {
		if errs[i] != nil || results[i] != "vip" {
			t.Fatalf("worker %d: value=%q err=%v", i, results[i], errs[i])
		}
	}
}

func TestCacheLocalGetOrLoadCachesFailureForErrorTTL(t *testing.T) {
	c := cachelocal.New[int64, string]()
	defer c.Close()
	ctx := context.Background()

	var calls atomic.Int32
	loadErr := errors.New("pay unavailable")
	loader := func(context.Context, int64) (string, error) {
		calls.Add(1)
		return "free", loadErr
	}

	for i := 0; i < 2; i++ {
		value, err := c.GetOrLoad(ctx, 7, time.Minute, 30*time.Millisecond, loader)
		if value != "free" || !errors.Is(err, loadErr) {
			t.Fatalf("call %d: value=%q err=%v", i, value, err)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("loader calls = %d, want 1 (failure cached)", got)
	}

	time.Sleep(60 * time.Millisecond)
	if _, err := c.GetOrLoad(ctx, 7, time.Minute, 30*time.Millisecond, loader); !errors.Is(err, loadErr) {
		t.Fatalf("after error TTL: err=%v, want loader error", err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("loader calls after error TTL = %d, want 2", got)
	}
}

func TestCacheLocalIsBounded(t *testing.T) {
	c := cachelocal.New[int64, int](cachelocal.WithMaxEntries(4))
	defer c.Close()
	ctx := context.Background()

	for i := int64(0); i < 20; i++ {
		c.Set(ctx, i, int(i), time.Minute)
	}
	if got := c.Len(); got > 4 {
		t.Fatalf("Len = %d, want <= 4", got)
	}
}

func TestCacheLocalDelete(t *testing.T) {
	c := cachelocal.New[string, int]()
	defer c.Close()
	ctx := context.Background()
	c.Set(ctx, "a", 1, time.Minute)
	c.Delete(ctx, "a")
	if _, ok := c.Get(ctx, "a"); ok {
		t.Fatal("deleted key should miss")
	}
}
