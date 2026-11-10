package logger

import (
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"
)

// rotatingWriter rotates file by size, compresses archives (gzip/zstd) and
// enforces count/age/total-size retention. The active file stays plain text so
// tail -f / collectors can read it directly.
type rotatingWriter struct {
	cfg FileOptions

	mu   sync.Mutex
	file *os.File
	size int64

	jobs      chan string
	workers   sync.WaitGroup
	closeOnce sync.Once
}

func newRotatingWriter(cfg FileOptions) *rotatingWriter {
	if cfg.Path == "" {
		cfg.Path = "/app/logs/app-user.log"
	}
	if cfg.MaxSize <= 0 {
		cfg.MaxSize = 100
	}
	if cfg.MaxBackups == 0 {
		cfg.MaxBackups = 7
	}
	if cfg.MaxAge == 0 {
		cfg.MaxAge = 30
	}
	if cfg.CompressLevel == 0 {
		cfg.CompressLevel = 6
	}
	if cfg.CompressAlgorithm == "" {
		cfg.CompressAlgorithm = "gzip"
	}
	if cfg.CompressQueue <= 0 {
		cfg.CompressQueue = 8
	}
	w := &rotatingWriter{cfg: cfg}
	if cfg.Compress {
		w.jobs = make(chan string, cfg.CompressQueue)
		for i := 0; i < compressionWorkers(cfg.CompressQueue); i++ {
			w.workers.Add(1)
			go w.compressWorker()
		}
	}
	if err := os.MkdirAll(filepath.Dir(cfg.Path), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "logger: mkdir %s: %v\n", filepath.Dir(cfg.Path), err)
	}
	if err := w.openActive(); err != nil {
		fmt.Fprintf(os.Stderr, "logger: open %s: %v\n", cfg.Path, err)
	}
	return w
}

func compressionWorkers(queue int) int {
	if queue <= 8 {
		return 1
	}
	return 2
}

func (w *rotatingWriter) openActive() error {
	f, err := os.OpenFile(w.cfg.Path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	w.file = f
	if st, err := f.Stat(); err == nil {
		w.size = st.Size()
	}
	return nil
}

func (w *rotatingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return 0, fmt.Errorf("logger: rotating writer closed")
	}
	maxBytes := int64(w.cfg.MaxSize) * 1024 * 1024
	if maxBytes > 0 && w.size+int64(len(p)) > maxBytes {
		w.rotateLocked()
	}
	n, err := w.file.Write(p)
	w.size += int64(n)
	return n, err
}

func (w *rotatingWriter) rotateLocked() {
	if w.file == nil {
		return
	}
	_ = w.file.Close()
	w.file = nil
	backup := w.cfg.Path + "." + time.Now().Format("2006-01-02T15-04-05.000")
	if err := os.Rename(w.cfg.Path, backup); err != nil {
		fmt.Fprintf(os.Stderr, "logger: rotate rename: %v\n", err)
		_ = w.openActive()
		return
	}
	w.size = 0
	if err := w.openActive(); err != nil {
		fmt.Fprintf(os.Stderr, "logger: rotate reopen: %v\n", err)
	}
	if w.cfg.Compress && w.jobs != nil {
		select {
		case w.jobs <- backup:
		default:
			// Queue full: keep the raw archive and let the next cleanup pass
			// compress it once capacity is free.
		}
	}
	if !w.cfg.Compress || w.jobs == nil {
		go w.cleanup()
	}
}

func (w *rotatingWriter) compressWorker() {
	defer w.workers.Done()
	for src := range w.jobs {
		if err := w.compressFile(src); err != nil {
			fmt.Fprintf(os.Stderr, "logger: compress %s: %v\n", src, err)
		}
		w.cleanup()
	}
}

func (w *rotatingWriter) compressFile(src string) error {
	algo := strings.ToLower(strings.TrimSpace(w.cfg.CompressAlgorithm))
	if algo != "zstd" {
		algo = "gzip"
	}
	dst := src + "." + map[string]string{"gzip": "gz", "zstd": "zst"}[algo]
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst+".tmp", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	var cw io.WriteCloser
	if algo == "zstd" {
		cw, err = zstd.NewWriter(out, zstd.WithEncoderLevel(zstd.EncoderLevelFromZstd(w.cfg.CompressLevel)))
	} else {
		cw, err = gzip.NewWriterLevel(out, w.cfg.CompressLevel)
	}
	if err != nil {
		_ = out.Close()
		_ = os.Remove(dst + ".tmp")
		return err
	}
	if _, err = io.Copy(cw, in); err != nil {
		_ = cw.Close()
		_ = out.Close()
		_ = os.Remove(dst + ".tmp")
		return err
	}
	if err = cw.Close(); err != nil {
		_ = out.Close()
		_ = os.Remove(dst + ".tmp")
		return err
	}
	if err = out.Close(); err != nil {
		_ = os.Remove(dst + ".tmp")
		return err
	}
	_ = in.Close()
	if err = os.Rename(dst+".tmp", dst); err != nil {
		_ = os.Remove(dst + ".tmp")
		return err
	}
	return os.Remove(src)
}

// cleanup enforces max_backups / max_age / max_total_size. It only touches
// files owned by this logger (the configured path + timestamp suffix).
func (w *rotatingWriter) cleanup() {
	dir := filepath.Dir(w.cfg.Path)
	base := filepath.Base(w.cfg.Path)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type backup struct {
		path string
		mod  time.Time
		size int64
	}
	var backups []backup
	now := time.Now()
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), base+".") || e.Name() == base {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if w.cfg.MaxAge > 0 && now.Sub(info.ModTime()) > time.Duration(w.cfg.MaxAge)*24*time.Hour {
			_ = os.Remove(filepath.Join(dir, e.Name()))
			continue
		}
		backups = append(backups, backup{path: filepath.Join(dir, e.Name()), mod: info.ModTime(), size: info.Size()})
	}
	sort.Slice(backups, func(i, j int) bool { return backups[i].mod.After(backups[j].mod) })
	var total int64
	for i, b := range backups {
		total += b.size
		tooMany := w.cfg.MaxBackups > 0 && i >= w.cfg.MaxBackups
		tooBig := w.cfg.MaxTotalSize > 0 && total > int64(w.cfg.MaxTotalSize)*1024*1024
		if tooMany || tooBig {
			_ = os.Remove(b.path)
		}
	}
}

func (w *rotatingWriter) Close() error {
	var err error
	w.closeOnce.Do(func() {
		w.mu.Lock()
		if w.file != nil {
			err = w.file.Close()
			w.file = nil
		}
		w.mu.Unlock()
		if w.jobs != nil {
			close(w.jobs)
			w.workers.Wait()
		}
	})
	return err
}
