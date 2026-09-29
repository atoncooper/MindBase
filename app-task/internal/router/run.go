// Package router: on-demand script execution — the central run container.
//
// Same execution pipeline as scheduled dispatch (latest version, compile
// cache, pooled VM, per-run timeout), but triggered directly: the console
// test-run pages and the /internal/script/run platform endpoint. Every run is
// persisted to script_run (status, captured ctx.log output, duration) so
// results stay inspectable and auditable; scheduled task runs keep going to
// task_log and are unaffected.
package router

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"app-task/internal/executor"
	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/datatypes"
)

// runScriptOnce executes one script ad-hoc and persists the outcome. The
// payload is passed to ctx.payload() verbatim (script_id need not be inside).
func (r *Router) runScriptOnce(scriptID string, payload []byte) (*model.ScriptRun, error) {
	latest, err := repo.GetLatestScript(scriptID)
	if err != nil {
		return nil, err // repo.ErrScriptNotFound passes through to callers
	}
	var logs []string
	task := executor.Task{
		ID:      "run-" + uuid.NewString()[:8],
		Payload: payload,
		LogSink: func(msg string) { logs = append(logs, msg) },
	}

	start := time.Now()
	execErr := r.luaExec.Execute(context.Background(), scriptID, task)
	dur := time.Since(start).Milliseconds()

	run := &model.ScriptRun{
		RunID:      uuid.NewString(),
		ScriptID:   scriptID,
		Version:    latest.Version,
		Payload:    datatypes.JSON(payload),
		DurationMS: dur,
	}
	switch {
	case execErr == nil:
		run.Status = "success"
	case errors.Is(execErr, executor.ErrRetry):
		run.Status = "retry"
		msg := execErr.Error()
		run.Error = &msg
	default:
		run.Status = "failed"
		msg := execErr.Error()
		run.Error = &msg
	}
	if len(logs) > 0 {
		joined := strings.Join(logs, "\n")
		run.Logs = &joined
	}
	if err := repo.CreateScriptRun(run); err != nil {
		return run, err
	}
	return run, nil
}

// ── internal platform endpoint (APISIX key-auth) ────────────────────

func (r *Router) runScriptAPI(c *gin.Context) {
	if c.Request.ContentLength > maxTaskPayloadBytes {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "payload too large"})
		return
	}
	var req struct {
		ScriptID string          `json:"script_id" binding:"required,max=64"`
		Payload  json.RawMessage `json:"payload"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request: " + err.Error()})
		return
	}
	payload := []byte(req.Payload)
	if len(payload) == 0 {
		payload = []byte("{}")
	}
	run, err := r.runScriptOnce(req.ScriptID, payload)
	if errors.Is(err, repo.ErrScriptNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"detail": "script not found: " + req.ScriptID})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "run failed: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"run_id":      run.RunID,
		"script_id":   run.ScriptID,
		"version":     run.Version,
		"status":      run.Status,
		"error":       run.Error,
		"logs":        strings.Split(fmtStrPtr(run.Logs), "\n"),
		"duration_ms": run.DurationMS,
	})
}

// ── console pages (PRG) ─────────────────────────────────────────────

// pageScriptRunForm renders the test-run form (payload editor, prefilled {}).
func (r *Router) pageScriptRunForm(c *gin.Context) {
	id := c.Param("script_id")
	latest, err := repo.GetLatestScript(id)
	if errors.Is(err, repo.ErrScriptNotFound) {
		render404(c, "脚本不存在："+id)
		return
	}
	if err != nil {
		slog.Error("[PAGE] get script failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	renderPage(c.Writer, "script_run_form", struct {
		BaseData
		ScriptID, Name string
		Version        int
		Payload        string
	}{
		BaseData: newBase(c, "scripts", "运行脚本", "立即执行一次（不经过调度器），结果落 script_run 可回溯"),
		ScriptID: latest.ScriptID,
		Name:     latest.Name,
		Version:  latest.Version,
		Payload:  "{}",
	})
}

// handleScriptRun executes the script and redirects to the run result page.
func (r *Router) handleScriptRun(c *gin.Context) {
	id := c.Param("script_id")
	back := "/console/scripts/" + id + "/run"
	raw := strings.TrimSpace(c.PostForm("payload"))
	if raw == "" {
		raw = "{}"
	}
	if !json.Valid([]byte(raw)) {
		redirectFlash(c, back, "err", "payload 不是合法 JSON")
		return
	}
	run, err := r.runScriptOnce(id, []byte(raw))
	if errors.Is(err, repo.ErrScriptNotFound) {
		render404(c, "脚本不存在："+id)
		return
	}
	if err != nil {
		redirectFlash(c, back, "err", "执行结果落库失败：%v", err)
		return
	}
	c.Redirect(http.StatusSeeOther, "/console/scripts/"+id+"/runs/"+run.RunID)
}

// pageScriptRunDetail renders one run's outcome: status, duration, captured
// ctx.log output, error, and the payload that was passed in.
func (r *Router) pageScriptRunDetail(c *gin.Context) {
	run, err := repo.GetScriptRun(c.Param("run_id"))
	if err != nil {
		slog.Error("[PAGE] get script run failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	if run == nil || run.ScriptID != c.Param("script_id") {
		render404(c, "运行记录不存在")
		return
	}
	st, sc := statusOf(run.Status)
	renderPage(c.Writer, "script_run_detail", struct {
		BaseData
		Run          *model.ScriptRun
		StatusText   string
		StatusCli    string
		Payload      string
		Logs         []string
		Error        string
		RunIDShort   string
		CreatedAtStr string
	}{
		BaseData:     newBase(c, "scripts", "运行结果", ""),
		Run:          run,
		StatusText:   st,
		StatusCli:    sc,
		Payload:      prettyJSON(run.Payload),
		Logs:         strings.Split(fmtStrPtr(run.Logs), "\n"),
		Error:        fmtStrPtr(run.Error),
		RunIDShort:   trunc(run.RunID, 18),
		CreatedAtStr: fmtTime(run.CreatedAt),
	})
}

// scriptRunRow is the shaped list item for the script detail runs panel.
type scriptRunRow struct {
	RunID, RunIDShort, StatusText, StatusClass, Duration, CreatedAt string
}

// recentScriptRuns loads the latest on-demand runs for the detail page.
func recentScriptRuns(scriptID string, limit int) []scriptRunRow {
	runs, err := repo.ListScriptRuns(scriptID, limit)
	if err != nil {
		return nil
	}
	rows := make([]scriptRunRow, 0, len(runs))
	for _, run := range runs {
		st, sc := statusOf(run.Status)
		rows = append(rows, scriptRunRow{
			RunID:       run.RunID,
			RunIDShort:  trunc(run.RunID, 12),
			StatusText:  st,
			StatusClass: sc,
			Duration:    duration(run.DurationMS),
			CreatedAt:   fmtTime(run.CreatedAt),
		})
	}
	return rows
}
