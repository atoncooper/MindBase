package tests

import (
	"testing"

	"app-cloud/internal/infra/cache/factory"
)

func TestCacheFactoryLocal(t *testing.T) {
	c, err := factory.New[int64, string](factory.Config{Backend: factory.Local, MaxEntries: 4})
	if err != nil {
		t.Fatalf("New(local): %v", err)
	}
	if c == nil {
		t.Fatal("New(local) returned nil")
	}
	defer c.Close()
}

func TestCacheFactoryRejectsUnknownBackend(t *testing.T) {
	if _, err := factory.New[int64, string](factory.Config{Backend: "bogus"}); err == nil {
		t.Fatal("expected an error for an unknown backend")
	}
}
