// ffmpeg helpers — port of the audio preprocessing in
// app/services/content_fetcher.py (transcode to 16k mono WAV, duration
// probe, long-audio splitting). ffmpeg/ffprobe are static binaries baked
// into the image (see Dockerfile).
package asr

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

func runCmd(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, truncate(string(out), 300))
	}
	return string(out), nil
}

// TranscodeToWav converts any audio container to 16k mono WAV (ASR input).
func TranscodeToWav(ctx context.Context, in, out string) error {
	_, err := runCmd(ctx, "ffmpeg", "-y", "-i", in, "-ac", "1", "-ar", "16000", "-vn", out)
	return err
}

// DurationSeconds probes media duration via ffprobe.
func DurationSeconds(ctx context.Context, path string) (float64, error) {
	out, err := runCmd(ctx, "ffprobe",
		"-v", "error", "-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1", path)
	if err != nil {
		return 0, err
	}
	return strconv.ParseFloat(strings.TrimSpace(out), 64)
}

// SplitWav cuts a WAV into fixed-length chunks; returns chunk paths in
// order. Last chunk may be shorter.
func SplitWav(ctx context.Context, in, outDir string, chunkSeconds int) ([]string, error) {
	dur, err := DurationSeconds(ctx, in)
	if err != nil {
		return nil, err
	}
	total := int(dur)
	if total <= chunkSeconds {
		return []string{in}, nil
	}
	var chunks []string
	for start := 0; start < total; start += chunkSeconds {
		out := filepath.Join(outDir, fmt.Sprintf("chunk_%06d.wav", start))
		if _, err := runCmd(ctx, "ffmpeg", "-y",
			"-i", in, "-ss", strconv.Itoa(start), "-t", strconv.Itoa(chunkSeconds),
			"-c", "copy", out); err != nil {
			return nil, err
		}
		chunks = append(chunks, out)
	}
	return chunks, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// EnsureTmpDir creates the ASR temp dir.
func EnsureTmpDir(dir string) error { return os.MkdirAll(dir, 0o755) }
