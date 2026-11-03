package service

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// ArtifactCandidate is one output file reported by the runtime. The control
// plane turns it into a metadata row; the bytes live in object storage.
type ArtifactCandidate struct {
	Name        string
	SizeBytes   int64
	SHA256      string
	ContentType string
	ObjectKey   string
}

// ArtifactStore collects declared output files from a sandbox and hands out
// short-lived download URLs. The fake below keeps the pipeline testable; the
// production implementation reads files through the execd API and uploads them
// to MinIO for presigned downloads.
type ArtifactStore interface {
	// Collect returns the files matching the declared globs (best effort).
	Collect(ctx context.Context, sandboxID string, globs []string) ([]ArtifactCandidate, error)
	// Presign returns a short-lived download URL for a stored object key.
	Presign(ctx context.Context, objectKey string, ttl time.Duration) (string, error)
}

// FakeArtifactStore returns canned candidates and fake:// presigned URLs.
type FakeArtifactStore struct {
	mu         sync.Mutex
	candidates []ArtifactCandidate
}

// NewFakeArtifactStore builds a fake store returning the given candidates.
func NewFakeArtifactStore(candidates ...ArtifactCandidate) *FakeArtifactStore {
	return &FakeArtifactStore{candidates: candidates}
}

// SetCandidates replaces the canned candidates (tests).
func (f *FakeArtifactStore) SetCandidates(candidates ...ArtifactCandidate) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.candidates = candidates
}

// Collect implements ArtifactStore.
func (f *FakeArtifactStore) Collect(_ context.Context, _ string, _ []string) ([]ArtifactCandidate, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]ArtifactCandidate, len(f.candidates))
	copy(out, f.candidates)
	return out, nil
}

// Presign implements ArtifactStore.
func (f *FakeArtifactStore) Presign(_ context.Context, objectKey string, _ time.Duration) (string, error) {
	return fmt.Sprintf("fake://sandbox-artifacts/%s", objectKey), nil
}
