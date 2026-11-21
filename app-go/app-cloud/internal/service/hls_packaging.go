package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func (s *HLSService) process(ctx context.Context, job hlsJob) error {
	jobTimeout := time.Duration(s.cfg.HLS.TimeoutSeconds)*time.Second + time.Minute
	runCtx, cancel := context.WithTimeout(ctx, jobTimeout)
	defer cancel()

	if s.isGone(ctx, job.UploadUUID) {
		return terminalJobErr(errors.New("file purged"))
	}
	file, err := s.files.GetByUUID(s.db, job.UploadUUID, job.UID)
	if err != nil {
		return transientJobErr(fmt.Errorf("load file: %w", err))
	}
	if file == nil {
		return terminalJobErr(errors.New("file not found"))
	}
	if !strings.HasPrefix(strings.ToLower(file.MimeType), "video/") {
		return unsupportedJobErr()
	}

	s.setStatus(ctx, job.UploadUUID, hlsStatus{Status: hlsStateProcessing, Progress: hlsProgressDownload})

	tmp, err := os.MkdirTemp("", "cloud-hls-*")
	if err != nil {
		return transientJobErr(fmt.Errorf("temp dir: %w", err))
	}
	defer os.RemoveAll(tmp)

	input := filepath.Join(tmp, "source")
	if err := s.minio.DownloadToFile(runCtx, file.ObjectKey, input); err != nil {
		return transientJobErr(fmt.Errorf("download: %w", err))
	}
	if runCtx.Err() != nil {
		return terminalJobErr(fmt.Errorf("download timed out: %w", runCtx.Err()))
	}

	outDir := filepath.Join(tmp, "hls")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return transientJobErr(fmt.Errorf("output dir: %w", err))
	}

	// Preflight: reject image-only/corrupt media before spending ffmpeg time and
	// choose copy / audio-only re-encode / full transcode from the real codecs.
	s.setStatus(ctx, job.UploadUUID, hlsStatus{Status: hlsStateProcessing, Progress: hlsProgressProbe})
	plan, err := s.buildPlanFor(runCtx, input)
	if err != nil {
		return err
	}

	s.setStatus(ctx, job.UploadUUID, hlsStatus{Status: hlsStateProcessing, Progress: hlsProgressPackage})
	timeout := time.Duration(s.cfg.HLS.TimeoutSeconds) * time.Second
	ffCtx, ffCancel := context.WithTimeout(runCtx, timeout)
	entry, err := s.packagePlan(ffCtx, input, outDir, plan)
	ffCancel()
	if err != nil {
		// ffmpeg failures are deterministic for a given source; do not burn
		// CPU on automatic retries (the user can still trigger a manual retry).
		return terminalJobErr(fmt.Errorf("ffmpeg: %w", err))
	}
	if s.isGone(ctx, job.UploadUUID) {
		return terminalJobErr(errors.New("file purged during packaging"))
	}

	// Derived previews are best-effort: never fail a playable package for them.
	thumbCtx, thumbCancel := context.WithTimeout(runCtx, 2*time.Minute)
	cover := s.renderThumbnails(thumbCtx, input, outDir, plan.Duration)
	thumbCancel()

	version, err := randomVersion()
	if err != nil {
		return transientJobErr(fmt.Errorf("version: %w", err))
	}
	prefix := s.objectPrefix(job.UID, job.UploadUUID, version)
	s.setStatus(ctx, job.UploadUUID, hlsStatus{Status: hlsStateProcessing, Progress: hlsProgressUpload})
	if err := s.uploadDir(runCtx, outDir, prefix, entry); err != nil {
		return transientJobErr(fmt.Errorf("upload: %w", err))
	}
	if s.isGone(ctx, job.UploadUUID) {
		// Purged while uploading: undo this version so no object outlives the row.
		s.deletePrefix(context.WithoutCancel(ctx), prefix+"/")
		return terminalJobErr(errors.New("file purged during upload"))
	}

	// Atomic publish: everything the entry playlist references is already in
	// place under an immutable version prefix before the status flips.
	s.setStatus(ctx, job.UploadUUID, hlsStatus{
		Status: hlsStateReady, Prefix: prefix, Version: version, Playlist: entry,
		Cover: cover, Progress: hlsProgressReady,
	})
	slog.Info("[HLS] ready", "upload_uuid", job.UploadUUID, "prefix", prefix,
		"playlist", entry, "renditions", len(plan.Renditions), "cover", cover)

	// Old versions are removed by the janitor only after every playback token
	// minted against them must have expired (see scheduleGC).
	s.scheduleGC(ctx, job.UID, job.UploadUUID, version)
	return nil
}

// ── stream preflight / packaging plan ────────────────────────────────

func (s *HLSService) packagePlan(ctx context.Context, input, outDir string, plan hlsPlan) (string, error) {
	if len(plan.Renditions) == 1 {
		if err := s.packageRendition(ctx, input, outDir, plan.Renditions[0]); err != nil {
			return "", err
		}
		return hlsPlaylistKey, nil
	}
	for _, r := range plan.Renditions {
		dir := filepath.Join(outDir, fmt.Sprintf("%dp", r.Height))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", err
		}
		if err := s.packageRendition(ctx, input, dir, r); err != nil {
			return "", err
		}
	}
	if err := s.writeMasterPlaylist(outDir, plan); err != nil {
		return "", err
	}
	return hlsMasterKey, nil
}

// packageRendition encodes one rendition. If the copy path fails at runtime
// (probe was absent or wrong), fall back to a full transcode instead of failing
// the whole job.
func (s *HLSService) packageRendition(ctx context.Context, input, dir string, r hlsRendition) error {
	err := s.runRendition(ctx, input, dir, r)
	if err == nil {
		return nil
	}
	if !r.CopyVideo {
		return err
	}
	slog.Info("[HLS] remux failed, falling back to transcode", "height", r.Height, "err", err)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	r.CopyVideo = false
	r.CopyAudio = false
	return s.runRendition(ctx, input, dir, r)
}

func (s *HLSService) runRendition(ctx context.Context, input, dir string, r hlsRendition) error {
	// One primary video + one primary audio track (audio optional, so a silent
	// video still packages); extra tracks/attachments would produce a playlist
	// whose renditions players cannot switch. Subtitles/data are dropped because
	// MPEG-TS cannot carry mov_text.
	args := []string{"-y", "-i", input, "-map", "0:v:0"}
	if r.CopyVideo {
		args = append(args, "-c:v", "copy")
	} else {
		if r.Height > 0 {
			args = append(args, "-vf", fmt.Sprintf("scale=-2:%d", r.Height))
		}
		args = append(args,
			"-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
			"-max_muxing_queue_size", "2048")
	}
	args = append(args, "-map", "0:a:0?")
	if r.CopyAudio {
		args = append(args, "-c:a", "copy")
	} else {
		args = append(args, "-c:a", "aac", "-b:a", "128k")
	}
	args = append(args,
		"-sn", "-dn",
		"-f", "hls",
		"-hls_time", fmt.Sprint(s.cfg.HLS.SegmentSeconds),
		"-hls_playlist_type", "vod",
		"-hls_flags", "independent_segments",
		"-hls_segment_filename", filepath.Join(dir, "seg-%05d.ts"),
		filepath.Join(dir, hlsPlaylistKey))
	return runFFmpeg(ctx, s.cfg.HLS.FFmpeg, args)
}

// writeMasterPlaylist points at each rendition's media playlist. BANDWIDTH is
// derived from the produced segment bytes so ABR players can rank renditions
// without another probe; a resolution-based estimate is the fallback when the
// duration is unknown.
func (s *HLSService) writeMasterPlaylist(outDir string, plan hlsPlan) error {
	var b strings.Builder
	b.WriteString("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n\n")
	for _, r := range plan.Renditions {
		dir := fmt.Sprintf("%dp", r.Height)
		segments, _ := filepath.Glob(filepath.Join(outDir, dir, "seg-*.ts"))
		var bytes int64
		for _, seg := range segments {
			if fi, err := os.Stat(seg); err == nil {
				bytes += fi.Size()
			}
		}
		duration := plan.Duration
		if duration <= 0 {
			duration = float64(len(segments)) * float64(s.cfg.HLS.SegmentSeconds)
		}
		bandwidth := int64(0)
		if duration > 0 {
			bandwidth = int64(float64(bytes) * 8 / duration * 1.15)
		}
		if bandwidth <= 0 {
			bandwidth = int64(r.Width * r.Height / 2) // rough floor: ~0.5 bit/pixel
		}
		if bandwidth <= 0 {
			bandwidth = 500_000
		}
		fmt.Fprintf(&b, "#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d\n%s/%s\n\n",
			bandwidth, even(r.Width), even(r.Height), dir, hlsPlaylistKey)
	}
	return os.WriteFile(filepath.Join(outDir, hlsMasterKey), []byte(b.String()), 0o644)
}

// renderThumbnails produces a poster (cover.jpg) and up to 10 preview frames.
// Failures are logged, never fatal: the video itself is already playable.
func (s *HLSService) renderThumbnails(ctx context.Context, input, outDir string, duration float64) string {
	if !s.cfg.HLS.ThumbnailsEnabled() {
		return ""
	}
	cover := ""
	coverPath := filepath.Join(outDir, "cover.jpg")
	args := []string{"-y"}
	if duration > 2 {
		args = append(args, "-ss", fmt.Sprintf("%.3f", duration*0.1))
	}
	args = append(args, "-i", input, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3", coverPath)
	if err := runFFmpeg(ctx, s.cfg.HLS.FFmpeg, args); err != nil {
		slog.Warn("[HLS] cover render failed", "err", err)
	} else if fi, err := os.Stat(coverPath); err == nil && fi.Size() > 0 {
		cover = "cover.jpg"
	} else {
		_ = os.Remove(coverPath)
	}
	thumbDir := filepath.Join(outDir, "thumbs")
	if err := os.MkdirAll(thumbDir, 0o755); err != nil {
		return cover
	}
	thumbArgs := []string{"-y", "-i", input,
		"-vf", "fps=1/10,scale=320:-2", "-frames:v", "10", "-q:v", "4",
		filepath.Join(thumbDir, "thumb-%02d.jpg")}
	if err := runFFmpeg(ctx, s.cfg.HLS.FFmpeg, thumbArgs); err != nil {
		slog.Warn("[HLS] thumbnail render failed", "err", err)
		_ = os.RemoveAll(thumbDir)
	}
	// One sprite sheet (5x2 frames) for list hover/seek previews.
	spritePath := filepath.Join(outDir, "sprite.jpg")
	spriteArgs := []string{"-y", "-i", input,
		"-vf", "fps=1/10,scale=160:-2,tile=5x2", "-frames:v", "1", "-q:v", "5", spritePath}
	if err := runFFmpeg(ctx, s.cfg.HLS.FFmpeg, spriteArgs); err != nil {
		slog.Warn("[HLS] sprite render failed", "err", err)
		_ = os.Remove(spritePath)
	}
	return cover
}

func runFFmpeg(ctx context.Context, binary string, args []string) error {
	cmd := exec.CommandContext(ctx, binary, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, tail(string(out), 1200))
	}
	return nil
}

// uploadDir uploads every object except the entry playlist, then the entry
// playlist last: a client that somehow discovers the version prefix before
// publication never sees a playlist pointing at missing objects.
func (s *HLSService) uploadDir(ctx context.Context, dir, prefix, entry string) error {
	entryPath := filepath.Join(dir, filepath.FromSlash(entry))
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if path == entryPath {
			return nil
		}
		return s.uploadOne(ctx, dir, path, prefix)
	})
	if err != nil {
		return err
	}
	if _, statErr := os.Stat(entryPath); statErr != nil {
		return fmt.Errorf("ffmpeg produced no %s", entry)
	}
	return s.uploadOne(ctx, dir, entryPath, prefix)
}

func (s *HLSService) uploadOne(ctx context.Context, dir, path, prefix string) error {
	rel, err := filepath.Rel(dir, path)
	if err != nil {
		return err
	}
	key := prefix + "/" + filepath.ToSlash(rel)
	ct := "application/octet-stream"
	switch strings.ToLower(filepath.Ext(path)) {
	case ".m3u8":
		ct = "application/vnd.apple.mpegurl"
	case ".ts":
		ct = "video/mp2t"
	case ".m4s":
		ct = "video/iso.segment"
	case ".jpg", ".jpeg":
		ct = "image/jpeg"
	case ".png":
		ct = "image/png"
	}
	return s.minio.UploadFile(ctx, key, path, ct)
}

func randomVersion() (string, error) {
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "v" + hex.EncodeToString(buf), nil
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

// HLSService packages uploaded videos into HLS with ffmpeg and issues the
// short-lived edge token used by OpenResty. Video bytes never flow through
// this service: OpenResty proxies the HLS prefix from MinIO.
