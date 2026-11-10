package tests

import (
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	applogger "app-user/internal/logger"
)

func TestLogRotationCompressesArchives(t *testing.T) {
	for _, tc := range []struct {
		name string
		algo string
		ext  string
	}{
		{"gzip", "gzip", ".gz"},
		{"zstd", "zstd", ".zst"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			applogger.Init(applogger.Options{
				Level:  "info",
				Format: "json",
				Output: "file",
				File: applogger.FileOptions{
					Path:              filepath.Join(dir, "app.log"),
					MaxSize:           1,
					MaxBackups:        3,
					MaxAge:            1,
					Compress:          true,
					CompressAlgorithm: tc.algo,
					CompressLevel:     1,
					CompressQueue:     2,
				},
			})
			payload := strings.Repeat("x", 256*1024)
			for i := 0; i < 10; i++ {
				slog.Info("rotation-test", "payload", payload)
			}
			applogger.Close()

			matches, err := filepath.Glob(filepath.Join(dir, "app.log.*"+tc.ext))
			if err != nil {
				t.Fatal(err)
			}
			if len(matches) == 0 {
				t.Fatalf("expected %s archive", tc.ext)
			}
		})
	}
}
