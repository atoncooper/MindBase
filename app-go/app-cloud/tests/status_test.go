package tests

import (
	"testing"

	"app-cloud/internal/service"
)

// ASR only applies to video/audio. Every other upload must start as
// not_supported so the UI never shows a pending ASR badge that cannot resolve.
func TestASRStatusForMime(t *testing.T) {
	cases := map[string]string{
		"video/mp4":       "pending",
		"audio/mpeg":      "pending",
		"image/png":       "not_supported",
		"application/pdf": "not_supported",
		"text/plain":      "not_supported",
		"application/zip": "not_supported",
	}
	for mime, want := range cases {
		if got := service.ASRStatusForMime(mime); got != want {
			t.Fatalf("ASRStatusForMime(%q) = %q, want %q", mime, got, want)
		}
	}
}
