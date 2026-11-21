package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"sort"
	"strings"
)

// buildPlanFor probes the source and derives the packaging plan. A missing
// ffprobe binary degrades to the legacy copy-first plan instead of failing the
// deployment; any other probe failure marks the source unsupported/failed
// before ffmpeg burns CPU on it.
func (s *HLSService) buildPlanFor(ctx context.Context, input string) (hlsPlan, error) {
	probe, err := s.probe(ctx, input)
	if err != nil {
		var execErr *exec.Error
		if errors.As(err, &execErr) && errors.Is(execErr.Err, exec.ErrNotFound) {
			slog.Warn("[HLS] ffprobe not found; using copy-first plan", "probe", s.cfg.HLS.Probe)
			return hlsPlan{Renditions: []hlsRendition{{CopyVideo: true, CopyAudio: true}}}, nil
		}
		return hlsPlan{}, terminalJobErr(fmt.Errorf("probe: %w", err))
	}
	plan, err := s.buildPlan(probe)
	if err != nil {
		return hlsPlan{}, err
	}
	return plan, nil
}

func (s *HLSService) probe(ctx context.Context, input string) (hlsProbe, error) {
	args := []string{"-v", "error", "-print_format", "json", "-show_format", "-show_streams", input}
	cmd := exec.CommandContext(ctx, s.cfg.HLS.Probe, args...)
	out, err := cmd.Output()
	if err != nil {
		return hlsProbe{}, fmt.Errorf("ffprobe: %w: %s", err, tail(string(out), 400))
	}
	var p hlsProbe
	if err := json.Unmarshal(out, &p); err != nil {
		return hlsProbe{}, fmt.Errorf("ffprobe json: %w", err)
	}
	return p, nil
}

func (s *HLSService) buildPlan(p hlsProbe) (hlsPlan, error) {
	codec, pixFmt, width, height, rotation, ok := p.videoStream()
	if !ok || width <= 0 || height <= 0 {
		// No real video stream: audio-only, image-only or a container ffmpeg
		// cannot treat as video. Mark unsupported instead of retrying forever.
		return hlsPlan{}, unsupportedJobErr()
	}
	if strings.Contains(strings.ToLower(p.Format.FormatName), "image") {
		return hlsPlan{}, unsupportedJobErr()
	}
	duration := p.duration()
	copyable := strings.EqualFold(codec, "h264") && rotation == 0 && copyablePixelFormat(pixFmt)
	audioCopy := true
	for _, ac := range p.audioCodecs() {
		if !strings.EqualFold(ac, "aac") {
			audioCopy = false
			break
		}
	}
	single := hlsPlan{
		Renditions: []hlsRendition{{
			Height: even(height), Width: even(width),
			CopyVideo: copyable, CopyAudio: audioCopy,
		}},
		Duration: duration,
	}
	if !s.cfg.HLS.ABREnabled() || duration <= 0 {
		return single, nil
	}
	heights := cappedLadder(s.cfg.HLS.RenditionHeights, height)
	if len(heights) <= 1 {
		single.Renditions[0].Height = heights[0]
		single.Renditions[0].Width = even(width * heights[0] / height)
		return single, nil
	}
	plan := hlsPlan{Duration: duration}
	for _, h := range heights {
		// Audio can be remuxed into every rung when the source audio is AAC;
		// only the video has to be re-encoded for lower resolutions.
		r := hlsRendition{Height: h, Width: even(width * h / height), CopyAudio: audioCopy}
		// The source-height rung can be remuxed when the codec is already
		// browser-friendly; lower rungs must be re-encoded (downscale).
		if copyable && h == even(height) {
			r.CopyVideo = true
			r.Width = even(width)
		}
		plan.Renditions = append(plan.Renditions, r)
	}
	return plan, nil
}

// cappedLadder keeps only requested heights the source can provide, always
// includes the source height, and returns an ascending, de-duplicated ladder.
func cappedLadder(requested []int, sourceHeight int) []int {
	seen := make(map[int]bool)
	out := make([]int, 0, len(requested)+1)
	for _, h := range requested {
		h = even(h)
		if h <= 0 || h > sourceHeight || seen[h] {
			continue
		}
		seen[h] = true
		out = append(out, h)
	}
	if top := even(sourceHeight); top > 0 && !seen[top] {
		out = append(out, top)
	}
	if len(out) == 0 {
		out = append(out, even(sourceHeight))
	}
	sort.Ints(out)
	return out
}

// copyablePixelFormat lists the 8-bit 4:2:0 layouts browsers decode from TS.
func copyablePixelFormat(pixFmt string) bool {
	switch strings.ToLower(strings.TrimSpace(pixFmt)) {
	case "", "yuv420p", "yuvj420p", "nv12":
		return true
	default:
		return false
	}
}

func even(n int) int {
	if n <= 1 {
		return 2
	}
	if n%2 != 0 {
		return n - 1
	}
	return n
}

// ── rendering ────────────────────────────────────────────────────────
