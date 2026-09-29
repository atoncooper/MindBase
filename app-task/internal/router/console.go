// Package router: server-rendered admin console pages (html/template).
//
// Rendering model: each page is parsed together with base.tmpl into its own
// template set at startup (the page's {{define "content"}} overrides the
// base's empty block). Data is pre-shaped in Go handlers (formatted times /
// truncated text / status text+classes) so templates stay dumb and
// auto-escaping does the XSS work. Interactions follow the classic
// POST-redirect-GET pattern with ?ok=/?err= flash messages; the JSON /api/*
// group (webui.go) remains available for scripts / master-token callers.
package router

import (
	"encoding/json"
	"fmt"
	"html/template"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"app-task/internal/model"
	"app-task/internal/repo"
	"app-task/web"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/datatypes"
)

// ── template sets ───────────────────────────────────────────────────

var pageTemplates map[string]*template.Template

func init() {
	ssrPages := []string{
		"dashboard", "tasks", "task_detail", "task_form", "logs", "cluster",
		"scripts", "script_detail", "script_form", "script_run_form", "script_run_detail",
		"emails", "users", "apikeys", "apikey_created", "password", "secrets",
	}
	pageTemplates = make(map[string]*template.Template, len(ssrPages)+2)
	for _, p := range ssrPages {
		pageTemplates[p] = template.Must(template.New("base.tmpl").
			ParseFS(web.Templates, "templates/base.tmpl", "templates/"+p+".tmpl"))
	}
	pageTemplates["base"] = template.Must(template.New("base.tmpl").
		ParseFS(web.Templates, "templates/base.tmpl"))
	pageTemplates["login"] = template.Must(template.New("login.tmpl").
		ParseFS(web.Templates, "templates/login.tmpl"))
}

// renderPage executes a parsed page set. Console pages render from base.tmpl
// (which invokes the page's "content" block); login is standalone. Render
// errors are logged (headers may already be flushed).
func renderPage(w http.ResponseWriter, set string, data any) {
	t, ok := pageTemplates[set]
	if !ok {
		slog.Error("[PAGE] template set missing", "set", set)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	entry := "base.tmpl"
	if set == "login" {
		entry = "login.tmpl"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := t.ExecuteTemplate(w, entry, data); err != nil {
		slog.Error("[PAGE] render failed", "set", set, "err", err)
	}
}

// ── base data / flash ───────────────────────────────────────────────

type userData struct {
	Username string
	IsAdmin  bool
}

type flashData struct {
	Kind string // ok / err
	Msg  string
}

// BaseData is embedded into every page's data struct; templates access its
// fields directly via promotion.
type BaseData struct {
	Version   string
	User      userData
	Active    string // active tab id ("" / tasks / logs / scripts / emails / users)
	PageTitle string
	PageDesc  string
	Flash     *flashData
}

// newBase builds the shell data from the request: current user, active tab,
// title, and any ?ok=/?err= flash message left by a redirect.
func newBase(c *gin.Context, active, title, desc string) BaseData {
	b := BaseData{Version: webuiVersion, Active: active, PageTitle: title, PageDesc: desc}
	if s, ok := currentUser(c); ok {
		b.User = userData{Username: s.Username, IsAdmin: s.Role == "admin"}
	}
	if msg := c.Query("ok"); msg != "" {
		b.Flash = &flashData{Kind: "ok", Msg: msg}
	} else if msg := c.Query("err"); msg != "" {
		b.Flash = &flashData{Kind: "err", Msg: msg}
	}
	return b
}

// redirectFlash bounces back to path carrying an ?ok=/?err= flash message
// (POST-redirect-GET; messages are url-encoded and auto-escaped on render).
func redirectFlash(c *gin.Context, path, kind, format string, args ...any) {
	v := url.Values{}
	v.Set(kind, fmt.Sprintf(format, args...))
	sep := "?"
	if u, err := url.Parse(path); err == nil && u.RawQuery != "" {
		sep = "&"
	}
	c.Redirect(http.StatusSeeOther, path+sep+v.Encode())
}

// ── display shaping ─────────────────────────────────────────────────

// fmtTime renders wall-clock in the business timezone: DB values come back
// UTC-aware, and time.Local is pinned to the configured timezone (main.go), so
// convert explicitly instead of formatting the stored UTC offset.
func fmtTime(t time.Time) string { return t.In(time.Local).Format("2006-01-02 15:04:05") }

func fmtTimePtr(t *time.Time) string {
	if t == nil {
		return "—"
	}
	return fmtTime(*t)
}

// trunc shortens s for table cells; empty input renders as "—". The full
// value goes into the cell's title attribute (shape helpers return both).
func trunc(s string, n int) string {
	if s == "" {
		return "—"
	}
	if n > 0 && len(s) > n {
		return s[:n] + "…"
	}
	return s
}

var statusText = map[string]string{
	"pending": "待执行", "dispatching": "派发中", "running": "执行中", "completed": "已完成",
	"failed": "失败", "success": "成功", "accepted": "已接收",
	"timeout": "超时", "retry": "重试", "sent": "已发送",
	"dry_run": "模拟", "queued": "已入队", "sending": "发送中",
}

// Label suffixes follow the Bootstrap 3 contextual palette used by the
// console templates (label label-<class>).
var statusClass = map[string]string{
	"pending": "warning", "dispatching": "primary", "running": "primary", "completed": "success",
	"failed": "danger", "success": "success", "accepted": "primary",
	"timeout": "danger", "retry": "warning", "sent": "success",
	"dry_run": "default", "queued": "primary", "sending": "primary",
}

func statusOf(s string) (text, class string) {
	if t, ok := statusText[s]; ok {
		return t, statusClass[s]
	}
	return s, "gray"
}

func duration(ms int64) string {
	if ms <= 0 {
		return "—"
	}
	return strconv.FormatInt(ms, 10) + " ms"
}

// prettyJSON renders the opaque task payload for display: pretty-printed JSON
// when possible, raw string otherwise; empty → "" (template omits the block).
func prettyJSON(p datatypes.JSON) string {
	if len(p) == 0 {
		return ""
	}
	var buf json.RawMessage
	if err := json.Unmarshal(p, &buf); err == nil {
		out, err := json.MarshalIndent(buf, "", "  ")
		if err == nil {
			return string(out)
		}
	}
	return string(p)
}

// ── pagination (offset based, filters carried through) ──────────────

type pageNav struct {
	Total   int64
	From    int
	To      int
	PrevURL string
	NextURL string
}

// buildPageNav computes prev/next links for offset pagination, carrying the
// current query (status filters) forward.
func buildPageNav(c *gin.Context, path string, offset, limit int, total int64) pageNav {
	nav := pageNav{Total: total, From: offset + 1, To: offset + limit}
	if nav.To > int(total) {
		nav.To = int(total)
	}
	if total == 0 {
		nav.From, nav.To = 0, 0
	}
	withOffset := func(o int) string {
		v := url.Values{}
		for k, vs := range c.Request.URL.Query() {
			if k == "offset" {
				continue
			}
			for _, vv := range vs {
				v.Add(k, vv)
			}
		}
		v.Set("offset", strconv.Itoa(o))
		return path + "?" + v.Encode()
	}
	if offset > 0 {
		nav.PrevURL = withOffset(max(offset-limit, 0))
	}
	if offset+limit < int(total) {
		nav.NextURL = withOffset(offset + limit)
	}
	return nav
}

// ── row shapes ──────────────────────────────────────────────────────

type taskRow struct {
	TaskID, TaskIDShort, UID, TaskType, StatusText, StatusClass string
	TriggerTime, CronExpr, ExecutorURL, ExecutorShort           string
	RetryCount, MaxRetry                                        int
}

func shapeTask(j *model.Task, idLen int) taskRow {
	st, sc := statusOf(j.Status)
	return taskRow{
		TaskID:        j.TaskID,
		TaskIDShort:   trunc(j.TaskID, idLen),
		UID:           strconv.FormatInt(j.UID, 10),
		TaskType:      j.TaskType,
		StatusText:    st,
		StatusClass:   sc,
		TriggerTime:   fmtTime(j.TriggerTime),
		CronExpr:      trunc(j.CronExpr, 24),
		ExecutorURL:   j.ExecutorURL,
		ExecutorShort: trunc(j.ExecutorURL, 30),
		RetryCount:    j.RetryCount,
		MaxRetry:      j.MaxRetry,
	}
}

type taskLogRow struct {
	TriggerAt, TaskID, TaskIDShort, Executor, ExecutorShort string
	StatusText, StatusClass, Duration                       string
	Response, ResponseShort, Error, ErrorShort              string
}

func shapeTaskLog(l *model.TaskLog, cellLen int) taskLogRow {
	st, sc := statusOf(l.Status)
	resp, errMsg := "", ""
	if l.Response != "" {
		resp = l.Response
	}
	if l.Error != nil {
		errMsg = *l.Error
	}
	return taskLogRow{
		TriggerAt:     fmtTime(l.TriggerAt),
		TaskID:        l.TaskID,
		TaskIDShort:   trunc(l.TaskID, 16),
		Executor:      l.Executor,
		ExecutorShort: trunc(l.Executor, 28),
		StatusText:    st,
		StatusClass:   sc,
		Duration:      duration(l.DurationMS),
		Response:      resp,
		ResponseShort: trunc(resp, cellLen),
		Error:         errMsg,
		ErrorShort:    trunc(errMsg, cellLen),
	}
}

// ── pages: dashboard ────────────────────────────────────────────────

// clusterNodeRow is the dashboard's cluster roster row (liveness computed by
// the cluster manager; RFC3339 times re-formatted for display).
type clusterNodeRow struct {
	NodeID, Hostname, Version, StartedAt, LastHeartbeat, State string
	Weight                                                     int
	Claims                                                     int64
	Self, Alive                                                bool
}

func (r *Router) pageDashboard(c *gin.Context) {
	taskCounts, _ := repo.CountTasksByStatus()
	taskTotal, _ := repo.CountTasks("")
	logsTotal, _ := repo.CountTaskLogs()
	emailCounts, _ := repo.CountEmailsByStatus()
	emailTotal, _ := repo.CountEmails("")
	scripts, _ := repo.CountScripts()

	tasks, _ := repo.ListAllTasks("", 8, 0)
	recentTasks := make([]taskRow, 0, len(tasks))
	for i := range tasks {
		recentTasks = append(recentTasks, shapeTask(&tasks[i], 14))
	}
	logs, _ := repo.ListRecentLogs("", 8)
	recentLogs := make([]taskLogRow, 0, len(logs))
	for i := range logs {
		recentLogs = append(recentLogs, shapeTaskLog(&logs[i], 60))
	}

	clusterRows := []clusterNodeRow{}
	if clusterMgr != nil {
		if nodes, err := clusterMgr.Nodes(time.Now()); err == nil {
			for _, n := range nodes {
				clusterRows = append(clusterRows, clusterNodeRow{
					NodeID:        n.NodeID,
					Hostname:      n.Hostname,
					Version:       n.Version,
					Weight:        n.Weight,
					StartedAt:     fmtTimeRFC3339(n.StartedAt),
					LastHeartbeat: fmtTimeRFC3339(n.LastHeartbeat),
					Claims:        n.Claims,
					Self:          n.Self,
					Alive:         n.Alive,
				})
			}
		}
	}

	renderPage(c.Writer, "dashboard", struct {
		BaseData
		Tasks        gin.H
		Emails       gin.H
		LogsTotal    int64
		Scripts      int64
		RecentTasks  []taskRow
		RecentLogs   []taskLogRow
		ClusterNodes []clusterNodeRow
	}{
		BaseData:     newBase(c, "", "仪表盘", "任务调度 / 执行日志 / 邮件队列 / Lua 脚本 总览"),
		Tasks:        gin.H{"Total": taskTotal, "Pending": taskCounts["pending"], "Running": taskCounts["running"], "Completed": taskCounts["completed"], "Failed": taskCounts["failed"]},
		Emails:       gin.H{"Total": emailTotal, "Pending": emailCounts["pending"], "Sent": emailCounts["sent"], "Failed": emailCounts["failed"], "DryRun": emailCounts["dry_run"]},
		LogsTotal:    logsTotal,
		Scripts:      scripts,
		RecentTasks:  recentTasks,
		RecentLogs:   recentLogs,
		ClusterNodes: clusterRows,
	})
}

// pageCluster renders the cluster management page: roster (active/pending)
// with liveness and weights, plus the join flow (pre-register a node and get
// copy-paste instructions).
func (r *Router) pageCluster(c *gin.Context) {
	if _, ok := requireAdminPage(c); !ok {
		return
	}
	rows := []clusterNodeRow{}
	pendingRows := []clusterNodeRow{}
	if clusterMgr != nil {
		if nodes, err := clusterMgr.Nodes(time.Now()); err == nil {
			for _, n := range nodes {
				row := clusterNodeRow{
					NodeID:        n.NodeID,
					Hostname:      n.Hostname,
					Version:       n.Version,
					Weight:        n.Weight,
					State:         n.State,
					StartedAt:     fmtTimeRFC3339(n.StartedAt),
					LastHeartbeat: fmtTimeRFC3339(n.LastHeartbeat),
					Claims:        n.Claims,
					Self:          n.Self,
					Alive:         n.Alive,
				}
				if n.State == "pending_join" {
					pendingRows = append(pendingRows, row)
				} else {
					rows = append(rows, row)
				}
			}
		}
	}
	// Post-redirect-GET join result: regenerate instructions for ?joined=<id>.
	var instructions string
	var joinedID string
	if id := strings.TrimSpace(c.Query("joined")); id != "" {
		weight := 1
		if w := c.Query("weight"); w != "" {
			if n, err := strconv.Atoi(w); err == nil && n > 0 {
				weight = n
			}
		}
		instructions = clusterJoinInstructions(id, weight, r.cfg.Cluster.Admission)
		joinedID = id
	}
	renderPage(c.Writer, "cluster", struct {
		BaseData
		Nodes        []clusterNodeRow
		PendingNodes []clusterNodeRow
		Instructions string
		JoinedID     string
	}{
		BaseData:     newBase(c, "cluster", "集群", "节点名册 / 心跳存活 / 加入节点"),
		Nodes:        rows,
		PendingNodes: pendingRows,
		Instructions: instructions,
		JoinedID:     joinedID,
	})
}

// handleClusterJoin processes the console join form (admin): pre-register and
// redirect back with the joined node id so the page renders the instructions.
func (r *Router) handleClusterJoin(c *gin.Context) {
	s, ok := requireAdminPage(c)
	if !ok {
		return
	}
	nodeID := strings.TrimSpace(c.PostForm("node_id"))
	weight, _ := strconv.Atoi(strings.TrimSpace(c.PostForm("weight")))
	if weight <= 0 {
		weight = 1
	}
	if msg := validateClusterJoin(nodeID, strings.TrimSpace(c.PostForm("hostname")), weight); msg != "" {
		redirectFlash(c, "/console/cluster", "err", "%s", msg)
		return
	}
	_, err := repo.JoinNode(&model.ClusterNode{
		NodeID:    nodeID,
		Hostname:  strings.TrimSpace(c.PostForm("hostname")),
		Weight:    weight,
		State:     repo.NodeStatePendingJoin,
		JoinedVia: "web",
		InvitedBy: s.Username,
	})
	if err == repo.ErrNodeActive {
		redirectFlash(c, "/console/cluster", "err", "节点已在集群中：%s", nodeID)
		return
	}
	if err != nil {
		redirectFlash(c, "/console/cluster", "err", "加入失败：%v", err)
		return
	}
	slog.Info("[CLUSTER] node pre-registered via console", "node_id", nodeID, "weight", weight, "operator", s.Username)
	c.Redirect(http.StatusSeeOther, fmt.Sprintf("/console/cluster?joined=%s&weight=%d&ok=1", url.QueryEscape(nodeID), weight))
}

// fmtTimeRFC3339 formats an RFC3339 string in the business timezone.
func fmtTimeRFC3339(s string) string {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return s
	}
	return t.In(time.Local).Format("2006-01-02 15:04:05")
}

// ── pages: tasks ────────────────────────────────────────────────────

func (r *Router) pageTasks(c *gin.Context) {
	status := c.Query("status")
	offset, limit := 0, 20
	if o, err := strconv.Atoi(c.Query("offset")); err == nil && o > 0 {
		offset = o
	}
	tasks, err := repo.ListAllTasks(status, limit, offset)
	if err != nil {
		slog.Error("[PAGE] list tasks failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	total, _ := repo.CountTasks(status)
	items := make([]taskRow, 0, len(tasks))
	for i := range tasks {
		items = append(items, shapeTask(&tasks[i], 16))
	}
	renderPage(c.Writer, "tasks", struct {
		BaseData
		Status string
		Items  []taskRow
		Nav    pageNav
	}{
		BaseData: newBase(c, "tasks", "任务管理", "全量任务（跨 uid）：状态过滤、新建、详情溯源"),
		Status:   status,
		Items:    items,
		Nav:      buildPageNav(c, "/console/tasks", offset, limit, total),
	})
}

func (r *Router) pageTaskNew(c *gin.Context) {
	// Prefill from query (e.g. the script detail page's "创建定时任务" button
	// links here with task_type=lua&script_id=...).
	taskType := c.Query("task_type")
	if taskType != "http" && taskType != "lua" {
		taskType = "http"
	}
	scriptID := c.Query("script_id")
	payload := ""
	if scriptID != "" {
		payload = fmt.Sprintf(`{"script_id": %q}`, scriptID)
	}

	// Enabled scripts for the lua task's script picker (rendered server-side;
	// the payload script_id stays editable for advanced cases).
	scripts, _ := repo.ListScripts()
	options := make([]gin.H, 0, len(scripts))
	for _, s := range scripts {
		if !s.Enabled {
			continue
		}
		options = append(options, gin.H{"ScriptID": s.ScriptID, "Name": s.Name})
	}

	base := newBase(c, "tasks", "新建任务", "任务 = 调度定义（类型 + payload + 执行器 + cron/触发时间 + 重试）")
	renderPage(c.Writer, "task_form", struct {
		BaseData
		TaskType, ScriptID, Payload, Owner string
		Scripts                            []gin.H
	}{
		BaseData: base,
		TaskType: taskType,
		ScriptID: scriptID,
		Payload:  payload,
		Owner:    base.User.Username,
		Scripts:  options,
	})
}

func (r *Router) pageTaskDetail(c *gin.Context) {
	task, err := repo.GetTaskByID(c.Param("task_id"))
	if err != nil {
		slog.Error("[PAGE] get task failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	if task == nil {
		render404(c, "任务不存在："+c.Param("task_id"))
		return
	}
	st, sc := statusOf(task.Status)
	t := shapeTask(task, 0)
	fields := []struct {
		K, V string
		Long bool
	}{
		{"uid", t.UID, false}, {"任务类型", t.TaskType, false},
		{"认领实例", trunc(task.Owner, 0), false},
		{"触发时间", t.TriggerTime, false}, {"cron 表达式", trunc(task.CronExpr, 0), false},
		{"执行器", trunc(task.ExecutorURL, 0), false}, {"异步", map[bool]string{true: "是（回调完成）", false: "否（同步）"}[task.Async], false},
		{"max_retry", strconv.Itoa(task.MaxRetry), false}, {"retry_count", strconv.Itoa(task.RetryCount), false},
		{"下次重试", fmtTimePtr(task.NextRetryAt), false}, {"weight", strconv.Itoa(task.Weight), false},
		{"创建时间", fmtTime(task.CreatedAt), false}, {"更新时间", fmtTime(task.UpdatedAt), false},
		{"最近结果", trunc(fmtStrPtr(task.LastResult), 0), true},
	}
	if task.CronNextTaskID != "" {
		fields = append(fields, struct {
			K, V string
			Long bool
		}{"下次 cron 任务", task.CronNextTaskID, false})
	}

	logs, _ := repo.ListTaskLogs(task.TaskID, 50)
	logRows := make([]taskLogRow, 0, len(logs))
	for i := range logs {
		logRows = append(logRows, shapeTaskLog(&logs[i], 0))
	}

	renderPage(c.Writer, "task_detail", struct {
		BaseData
		Task   taskRow
		Status string
		Class  string
		Fields []struct {
			K, V string
			Long bool
		}
		Payload string
		Logs    []taskLogRow
	}{
		BaseData: newBase(c, "tasks", "任务详情", ""),
		Task:     t,
		Status:   st,
		Class:    sc,
		Fields:   fields,
		Payload:  prettyJSON(task.Payload),
		Logs:     logRows,
	})
}

func fmtStrPtr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// sessionUID resolves the console operator's numeric owner id for task
// ownership: the webui_user row id. Master-token sessions (no user row)
// own tasks as 0 (system).
func sessionUID(c *gin.Context) int64 {
	s, ok := currentUser(c)
	if !ok || s.UserID == "" {
		return 0
	}
	uid, err := resolveUserID(s.UserID)
	if err != nil {
		return 0
	}
	return uid
}

// handleTaskCreate registers a task from the console form. Ownership is not
// an input: tasks are attributed to the logged-in console user (admin or
// member alike); master-token sessions fall back to uid 0. Validation errors
// bounce back with a flash.
func (r *Router) handleTaskCreate(c *gin.Context) {
	uid := sessionUID(c)
	taskType := c.PostForm("task_type")
	if taskType != "http" && taskType != "lua" {
		redirectFlash(c, "/console/tasks/new", "err", "任务类型必须是 http 或 lua")
		return
	}
	cron := strings.TrimSpace(c.PostForm("cron_expr"))
	triggerRaw := strings.TrimSpace(c.PostForm("trigger_time"))
	var trigger time.Time
	if triggerRaw != "" {
		for _, layout := range []string{"2006-01-02T15:04", "2006-01-02T15:04:05", time.RFC3339} {
			if t, err := time.ParseInLocation(layout, triggerRaw, time.Local); err == nil {
				trigger = t
				break
			}
		}
		if trigger.IsZero() {
			redirectFlash(c, "/console/tasks/new", "err", "触发时间格式不正确")
			return
		}
	}
	if cron == "" && trigger.IsZero() {
		redirectFlash(c, "/console/tasks/new", "err", "cron 与触发时间至少填一个")
		return
	}
	maxRetry, _ := strconv.Atoi(c.PostForm("max_retry"))
	weight, _ := strconv.Atoi(c.PostForm("weight"))
	if weight <= 0 {
		weight = 1
	}
	var payload json.RawMessage
	if raw := strings.TrimSpace(c.PostForm("payload")); raw != "" {
		if !json.Valid([]byte(raw)) {
			redirectFlash(c, "/console/tasks/new", "err", "payload 不是合法 JSON")
			return
		}
		payload = json.RawMessage(raw)
	}
	// Lua tasks must reference a registered script via payload.script_id —
	// the dispatcher routes them to the Lua executor by that field.
	if taskType == "lua" {
		var probe struct {
			ScriptID string `json:"script_id"`
		}
		_ = json.Unmarshal(payload, &probe)
		if strings.TrimSpace(probe.ScriptID) == "" {
			redirectFlash(c, "/console/tasks/new", "err", "lua 任务需要在 payload 中指定 script_id（选择「执行脚本」会自动写入）")
			return
		}
		if latest, err := repo.GetLatestScript(strings.TrimSpace(probe.ScriptID)); err != nil || latest == nil {
			redirectFlash(c, "/console/tasks/new", "err", "脚本不存在：%s", strings.TrimSpace(probe.ScriptID))
			return
		}
	}
	taskID, err := r.taskSvc.RegisterTask(uid, taskType, payload, strings.TrimSpace(c.PostForm("executor_url")), c.PostForm("async") == "on", cron, trigger, maxRetry, weight)
	if err != nil {
		redirectFlash(c, "/console/tasks/new", "err", "创建失败：%v", err)
		return
	}
	redirectFlash(c, "/console/tasks/"+taskID, "ok", "任务已创建：%s", taskID)
}

// ── pages: logs ─────────────────────────────────────────────────────

func (r *Router) pageLogs(c *gin.Context) {
	taskID := strings.TrimSpace(c.Query("task_id"))
	logs, err := repo.ListRecentLogs(taskID, 100)
	if err != nil {
		slog.Error("[PAGE] list logs failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	items := make([]taskLogRow, 0, len(logs))
	for i := range logs {
		items = append(items, shapeTaskLog(&logs[i], 80))
	}
	renderPage(c.Writer, "logs", struct {
		BaseData
		TaskID string
		Items  []taskLogRow
	}{
		BaseData: newBase(c, "logs", "执行日志", "跨任务的最新执行记录（最近 100 条，可按 task_id 过滤）"),
		TaskID:   taskID,
		Items:    items,
	})
}

// ── pages: scripts ──────────────────────────────────────────────────

type scriptRow struct {
	ScriptID, Name, Description, DescriptionShort string
	Version                                       int
	Enabled                                       bool
	UpdatedAt                                     string
}

func (r *Router) pageScripts(c *gin.Context) {
	scripts, err := repo.ListScripts()
	if err != nil {
		slog.Error("[PAGE] list scripts failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	items := make([]scriptRow, 0, len(scripts))
	for _, s := range scripts {
		items = append(items, scriptRow{
			ScriptID:         s.ScriptID,
			Name:             s.Name,
			Description:      s.Description,
			DescriptionShort: trunc(s.Description, 40),
			Version:          s.Version,
			Enabled:          s.Enabled,
			UpdatedAt:        fmtTime(s.UpdatedAt),
		})
	}
	renderPage(c.Writer, "scripts", struct {
		BaseData
		Items []scriptRow
	}{
		BaseData: newBase(c, "scripts", "Lua 脚本", "上传即编译为新版本、立即生效；启停记录审计"),
		Items:    items,
	})
}

func (r *Router) pageScriptDetail(c *gin.Context) {
	id := c.Param("script_id")
	latest, err := repo.GetLatestScript(id)
	if err == repo.ErrScriptNotFound {
		render404(c, "脚本不存在："+id)
		return
	}
	if err != nil {
		slog.Error("[PAGE] get script failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	versions, _ := repo.ListScriptVersions(id)
	verRows := make([]gin.H, 0, len(versions))
	for _, v := range versions {
		verRows = append(verRows, gin.H{
			"Version": v.Version, "Name": v.Name, "Enabled": v.Enabled,
			"UpdatedAt": fmtTime(v.UpdatedAt), "Current": v.Version == latest.Version,
		})
	}
	audit, _ := repo.ListScriptLogs(id, 50)
	logRows := make([]gin.H, 0, len(audit))
	for _, l := range audit {
		logRows = append(logRows, gin.H{
			"CreatedAt": fmtTime(l.CreatedAt), "Action": l.Action, "Version": l.Version,
			"Operator": trunc(l.Operator, 0), "SourceIP": trunc(l.SourceIP, 0),
			"Summary": trunc(l.Summary, 0), "RequestIDShort": trunc(l.RequestID, 16),
		})
	}
	renderPage(c.Writer, "script_detail", struct {
		BaseData
		ScriptID, Name, Description, Source string
		ScriptVersion                       int // named to avoid shadowing BaseData.Version (service version)
		Enabled                             bool
		Versions                            []gin.H
		Logs                                []gin.H
		Runs                                []scriptRunRow
	}{
		BaseData:      newBase(c, "scripts", "脚本详情", ""),
		ScriptID:      latest.ScriptID,
		Name:          latest.Name,
		Description:   latest.Description,
		Source:        latest.Source,
		ScriptVersion: latest.Version,
		Enabled:       latest.Enabled,
		Versions:      verRows,
		Logs:          logRows,
		Runs:          recentScriptRuns(latest.ScriptID, 20),
	})
}

// pageScriptForm renders the create/edit page. Edit pre-fills the latest
// version; saving always produces a NEW version.
// scriptExamples are built-in demo scripts surfaced on the create page —
// they document the ctx API (secret/http_req/payload/retry) with runnable
// code and can be imported with one click.
type scriptExample struct {
	ID, Title, Description, Source string
}

var scriptExamples = []scriptExample{
	{
		ID: "http-get-json", Title: "HTTP GET + JSON 解析", Description: "ctx.http_get + cjson",
		Source: `-- 示例：GET 请求 + JSON 解析
function handle(ctx)
  local body, status = ctx.http_get('https://httpbin.org/get?via=app-task')
  if not status then ctx.fail('http_get failed: ' .. body) end
  if status ~= 200 then ctx.retry('upstream ' .. status) end
  local data = cjson.decode(body)
  ctx.log('origin = ' .. (data.origin or 'unknown'))
end`,
	},
	{
		ID: "http-post-auth", Title: "POST + 密钥凭据", Description: "ctx.secret + 自定义请求头",
		Source: `-- 示例：POST + 中心密钥库凭据（先在「密钥管理」页创建同名密钥）
function handle(ctx)
  local token = ctx.secret('github_token')
  local payload = cjson.encode({ title = 'demo', source = 'app-task' })
  local body, status = ctx.http_req({
    method = 'POST',
    url = 'https://httpbin.org/post',
    headers = { Authorization = 'Bearer ' .. token, ['X-Request-Source'] = 'app-task' },
    body = payload,
    content_type = 'application/json',
  })
  if not status then ctx.fail('http_req failed: ' .. body) end
  ctx.log('status=' .. status)
end`,
	},
	{
		ID: "http-req-full", Title: "ctx.http_req 全参数", Description: "payload 转发 + 自定义头",
		Source: `-- 示例：ctx.http_req 全参数（method/url/headers/body/content_type）
function handle(ctx)
  local body, status = ctx.http_req({
    method = 'POST',
    url = 'https://httpbin.org/post',
    headers = { ['X-Custom-Header'] = 'any-value' },
    body = cjson.encode(ctx.payload()),  -- 任务 payload 原样转发
    content_type = 'application/json',
  })
  if not status then ctx.fail(body) end
  ctx.log('upstream ' .. status .. ', echo=' .. string.sub(body, 1, 80))
end`,
	},
	{
		ID: "payload-retry", Title: "payload + 失败重试", Description: "ctx.payload + ctx.retry",
		Source: `-- 示例：读取任务 payload + 失败重试（任务 max_retry 控制次数）
function handle(ctx)
  local p = ctx.payload()
  if not p.url then ctx.fail('payload 缺少 url') end
  local body, status = ctx.http_get(p.url)
  if not status or status ~= 200 then
    ctx.retry('upstream not ready: ' .. tostring(status))  -- 触发重试
    return
  end
  ctx.log('done, bytes=' .. tostring(string.len(body)))
end`,
	},
}

func scriptExampleByID(id string) (scriptExample, bool) {
	for _, ex := range scriptExamples {
		if ex.ID == id {
			return ex, true
		}
	}
	return scriptExample{}, false
}

func (r *Router) pageScriptForm(c *gin.Context) {
	edit := c.Request.URL.Path != "/console/scripts/new"
	data := struct {
		BaseData
		Edit                                bool
		ScriptID, Name, Description, Source string
		Enabled                             bool
		Examples                            []scriptExample
		ExampleID                           string
	}{
		BaseData: newBase(c, "scripts", map[bool]string{true: "编辑脚本", false: "新建脚本"}[edit], ""),
		Edit:     edit,
		Enabled:  true,
		Source:   "-- 示例：任务触发时执行\nfunction handle(ctx)\n  ctx.log(\"hello from script\")\n  return\nend\n",
		Examples: scriptExamples,
	}
	// 从示例开始：?example=xxx 预填标题与源码（仅新建模式）
	if ex, ok := scriptExampleByID(c.Query("example")); ok && !edit {
		data.ExampleID = ex.ID
		data.Name = ex.Title
		data.Description = ex.Description
		data.Source = ex.Source
	}
	if edit {
		latest, err := repo.GetLatestScript(c.Param("script_id"))
		if err == repo.ErrScriptNotFound {
			render404(c, "脚本不存在："+c.Param("script_id"))
			return
		}
		if err != nil {
			slog.Error("[PAGE] get script failed", "err", err)
			http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
			return
		}
		data.ScriptID, data.Name, data.Description, data.Source, data.Enabled =
			latest.ScriptID, latest.Name, latest.Description, latest.Source, latest.Enabled
	}
	renderPage(c.Writer, "script_form", data)
}

// handleScriptSave compiles + persists a script version from the console form
// (same pipeline as the API upload; audit operator = console session user).
// The identifier is never a user input: new scripts always get a server-assigned
// UUID; edits keep the existing one via a hidden field.
func (r *Router) handleScriptSave(c *gin.Context) {
	edit := c.PostForm("edit") == "1"
	back := "/console/scripts/new"
	req := scriptUploadBody{
		Name:        strings.TrimSpace(c.PostForm("name")),
		Description: strings.TrimSpace(c.PostForm("description")),
		Source:      c.PostForm("source"),
		Operator:    operatorOf(c),
	}
	enabled := c.PostForm("enabled") == "on"
	req.Enabled = &enabled
	if edit {
		back = "/console/scripts/" + strings.TrimSpace(c.PostForm("script_id")) + "/edit"
		req.ScriptID = strings.TrimSpace(c.PostForm("script_id"))
		if req.ScriptID == "" {
			redirectFlash(c, back, "err", "缺少脚本标识")
			return
		}
	} else {
		req.ScriptID = uuid.NewString()
	}
	if req.Name == "" || strings.TrimSpace(req.Source) == "" {
		redirectFlash(c, back, "err", "名称 / 源码 必填")
		return
	}
	version, _, err := r.applyScriptUpload(req, c)
	if err != nil {
		redirectFlash(c, back, "err", "脚本被拒绝：%v", err)
		return
	}
	redirectFlash(c, "/console/scripts/"+req.ScriptID, "ok", "脚本已保存：%s v%d", req.ScriptID, version)
}

// handleScriptToggle flips the enabled flag on the latest version (no new
// version); every change is audit-logged with the console operator.
func (r *Router) handleScriptToggle(c *gin.Context) {
	id := c.Param("script_id")
	enabled := c.PostForm("enabled") == "1"
	latest, err := repo.GetLatestScript(id)
	if err == repo.ErrScriptNotFound {
		redirectFlash(c, "/console/scripts", "err", "脚本不存在：%s", id)
		return
	}
	if err != nil {
		redirectFlash(c, "/console/scripts", "err", "查询失败：%v", err)
		return
	}
	if err := repo.UpdateScriptEnabled(id, enabled); err != nil {
		redirectFlash(c, "/console/scripts", "err", "操作失败：%v", err)
		return
	}
	state := "enabled"
	if !enabled {
		state = "disabled"
	}
	_ = repo.CreateScriptLog(&model.ScriptLog{
		LogID:     uuid.NewString(),
		ScriptID:  id,
		Version:   latest.Version,
		Action:    "toggle",
		Operator:  operatorOf(c),
		SourceIP:  c.ClientIP(),
		RequestID: c.GetHeader("X-Request-Id"),
		Summary:   "v" + strconv.Itoa(latest.Version) + " " + state,
	})
	word := "启用"
	if !enabled {
		word = "停用"
	}
	redirectFlash(c, "/console/scripts", "ok", "已%s %s", word, id)
}

// ── pages: emails ───────────────────────────────────────────────────

type emailRow struct {
	EmailID, EmailIDShort, To, Subject, SubjectShort, ReferenceID string
	StatusRaw, StatusText, StatusClass                            string
	RetryCount, NextRetryAt, CreatedAt, SentAt                    string
}

func (r *Router) pageEmails(c *gin.Context) {
	status := c.Query("status")
	offset, limit := 0, 20
	if o, err := strconv.Atoi(c.Query("offset")); err == nil && o > 0 {
		offset = o
	}
	emails, err := repo.ListEmails(status, limit, offset)
	if err != nil {
		slog.Error("[PAGE] list emails failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	total, _ := repo.CountEmails(status)
	items := make([]emailRow, 0, len(emails))
	for _, e := range emails {
		st, sc := statusOf(e.Status)
		items = append(items, emailRow{
			EmailID:      e.EmailID,
			EmailIDShort: trunc(e.EmailID, 14),
			To:           strings.Join(toStringSlice(e.To), ", "),
			Subject:      e.Subject,
			SubjectShort: trunc(e.Subject, 30),
			ReferenceID:  trunc(e.ReferenceID, 0),
			StatusRaw:    e.Status,
			StatusText:   st,
			StatusClass:  sc,
			RetryCount:   strconv.Itoa(e.RetryCount),
			NextRetryAt:  fmtTimePtr(e.NextRetryAt),
			CreatedAt:    fmtTime(e.CreatedAt),
			SentAt:       fmtTimePtr(e.SentAt),
		})
	}
	renderPage(c.Writer, "emails", struct {
		BaseData
		Status string
		Items  []emailRow
		Nav    pageNav
	}{
		BaseData: newBase(c, "emails", "邮件队列", "平台邮件投递：执行器投递标准邮件，app-task 排队 + 重试"),
		Status:   status,
		Items:    items,
		Nav:      buildPageNav(c, "/console/emails", offset, limit, total),
	})
}

func (r *Router) handleEmailRetry(c *gin.Context) {
	id := c.Param("email_id")
	ok, err := repo.ResetEmailForRetry(id)
	if err != nil {
		redirectFlash(c, "/console/emails", "err", "操作失败：%v", err)
		return
	}
	if !ok {
		redirectFlash(c, "/console/emails", "err", "邮件不在失败状态（或不存在）：%s", id)
		return
	}
	redirectFlash(c, "/console/emails", "ok", "已重新入队：%s", id)
}

// ── pages: users (admin only) ───────────────────────────────────────

type userRow struct {
	UserID         string
	Username, Role string
	IsAdmin        bool
	IsSelf         bool
	CreatedAt      string
	Deletable      bool
}

func requireAdminPage(c *gin.Context) (webuiSession, bool) {
	s, ok := currentUser(c)
	if !ok || s.Role != "admin" {
		redirectFlash(c, "/console", "err", "需要 admin 角色")
		return s, false
	}
	return s, true
}

func (r *Router) pageUsers(c *gin.Context) {
	s, ok := requireAdminPage(c)
	if !ok {
		return
	}
	us, err := repo.ListUsers()
	if err != nil {
		slog.Error("[PAGE] list users failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	admins, _ := repo.CountUsersByRole("admin")
	items := make([]userRow, 0, len(us))
	for _, u := range us {
		deletable := u.UserID != s.UserID
		if u.Role == "admin" && admins <= 1 {
			deletable = false // 最后一个 admin 不可删
		}
		items = append(items, userRow{
			UserID:    u.UserID,
			Username:  u.Username,
			Role:      u.Role,
			IsAdmin:   u.Role == "admin",
			IsSelf:    u.UserID == s.UserID,
			CreatedAt: fmtTime(u.CreatedAt),
			Deletable: deletable,
		})
	}
	renderPage(c.Writer, "users", struct {
		BaseData
		Items []userRow
	}{
		BaseData: newBase(c, "users", "账户", "控制台账户与角色管理（webui_user，仅 admin 可见）"),
		Items:    items,
	})
}

func (r *Router) handleUserCreate(c *gin.Context) {
	s, ok := requireAdminPage(c)
	if !ok {
		return
	}
	username := strings.TrimSpace(c.PostForm("username"))
	password := c.PostForm("password")
	role := c.PostForm("role")
	if len(username) < 2 || len(username) > 64 {
		redirectFlash(c, "/console/users", "err", "用户名需 2–64 字符")
		return
	}
	if len(password) < 8 || len(password) > 128 {
		redirectFlash(c, "/console/users", "err", "密码需 8–128 位")
		return
	}
	if role == "" {
		role = "member"
	}
	if role != "admin" && role != "member" {
		redirectFlash(c, "/console/users", "err", "角色必须是 admin 或 member")
		return
	}
	u, err := repo.CreateUser(username, password, role)
	if err == repo.ErrUserExists {
		redirectFlash(c, "/console/users", "err", "用户名已存在：%s", username)
		return
	}
	if err != nil {
		slog.Error("[USER] create failed", "err", err, "operator", s.Username)
		redirectFlash(c, "/console/users", "err", "创建失败：%v", err)
		return
	}
	slog.Info("[USER] created", "operator", s.Username, "username", u.Username, "role", u.Role)
	redirectFlash(c, "/console/users", "ok", "账户已创建：%s（%s）", u.Username, u.Role)
}

func (r *Router) handleUserPassword(c *gin.Context) {
	s, ok := requireAdminPage(c)
	if !ok {
		return
	}
	uid, err := resolveUserID(c.Param("user_id"))
	if err != nil {
		redirectFlash(c, "/console/users", "err", "%v", err)
		return
	}
	password := c.PostForm("password")
	if len(password) < 8 || len(password) > 128 {
		redirectFlash(c, "/console/users", "err", "密码需 8–128 位")
		return
	}
	if err := repo.SetUserPassword(uid, password); err != nil {
		redirectFlash(c, "/console/users", "err", "修改失败：%v", err)
		return
	}
	slog.Info("[USER] password changed", "operator", s.Username, "user_id", uid)
	redirectFlash(c, "/console/users", "ok", "密码已更新")
}

func (r *Router) handleUserDelete(c *gin.Context) {
	s, ok := requireAdminPage(c)
	if !ok {
		return
	}
	uid, err := resolveUserID(c.Param("user_id"))
	if err != nil {
		redirectFlash(c, "/console/users", "err", "%v", err)
		return
	}
	if c.Param("user_id") == s.UserID {
		redirectFlash(c, "/console/users", "err", "不能删除自己的账户")
		return
	}
	target, err := repo.GetUserByID(uid)
	if err != nil || target == nil {
		redirectFlash(c, "/console/users", "err", "账户不存在")
		return
	}
	if target.Role == "admin" {
		admins, _ := repo.CountUsersByRole("admin")
		if admins <= 1 {
			redirectFlash(c, "/console/users", "err", "不能删除最后一个 admin")
			return
		}
	}
	if err := repo.DeleteUser(uid); err != nil {
		redirectFlash(c, "/console/users", "err", "删除失败：%v", err)
		return
	}
	slog.Info("[USER] deleted", "operator", s.Username, "username", target.Username, "user_id", uid)
	redirectFlash(c, "/console/users", "ok", "账户已删除：%s", target.Username)
}

// ── page mounting / login flow ──────────────────────────────────────

// registerPages mounts the SSR console: standalone login/logout + the gated
// page tree. GET pages render; POST endpoints follow redirect-after-post.
func (r *Router) registerPages(e *gin.Engine, auth *webuiAuthenticator) {
	// Static assets (stylesheet) stay public; *.html is hidden from the static
	// route — pages are served only through the gated handlers below.
	assetFS, err := fs.Sub(web.Assets, "assets")
	if err != nil {
		panic("web assets missing: " + err.Error())
	}
	e.StaticFS("/assets", http.FS(noHTMLFS{assetFS}))

	e.GET("/login", loginPageHandler(auth))
	e.POST("/login", loginSubmitHandler(auth))
	e.POST("/logout", logoutSubmitHandler(auth))

	// Root: bounce to the console when logged in, else to the login page.
	e.GET("/", func(c *gin.Context) {
		if _, ok := auth.authenticate(auth.extractToken(c)); ok {
			c.Redirect(http.StatusFound, "/console")
			return
		}
		c.Redirect(http.StatusFound, "/login")
	})

	// Console pages live under /console: the root path space is shared with
	// the APISIX-facing gateway contract endpoints (/tasks/*, /scripts*),
	// which must not move.
	pages := e.Group("/console", auth.pageGate())
	pages.GET("", r.pageDashboard)
	pages.GET("/tasks", r.pageTasks)
	pages.GET("/tasks/new", r.pageTaskNew)
	pages.GET("/tasks/:task_id", r.pageTaskDetail)
	pages.POST("/tasks", r.handleTaskCreate)
	pages.GET("/logs", r.pageLogs)
	pages.GET("/scripts", r.pageScripts)
	pages.GET("/scripts/new", r.pageScriptForm)
	pages.GET("/scripts/:script_id", r.pageScriptDetail)
	pages.GET("/scripts/:script_id/edit", r.pageScriptForm)
	pages.POST("/scripts", r.handleScriptSave)
	pages.POST("/scripts/:script_id/toggle", r.handleScriptToggle)
	pages.GET("/scripts/:script_id/run", r.pageScriptRunForm)
	pages.POST("/scripts/:script_id/run", r.handleScriptRun)
	pages.GET("/scripts/:script_id/runs/:run_id", r.pageScriptRunDetail)
	pages.GET("/cluster", r.pageCluster)
	pages.POST("/cluster/join", r.handleClusterJoin)
	pages.GET("/emails", r.pageEmails)
	pages.POST("/emails/:email_id/retry", r.handleEmailRetry)
	pages.GET("/users", r.pageUsers)
	pages.POST("/users", r.handleUserCreate)
	pages.POST("/users/:user_id/password", r.handleUserPassword)
	pages.POST("/users/:user_id/delete", r.handleUserDelete)
	pages.GET("/secrets", r.pageSecrets)
	pages.POST("/secrets", r.handleSecretCreate)
	pages.POST("/secrets/update", r.handleSecretUpdate)
	pages.POST("/secrets/:secret_id/delete", r.handleSecretDelete)
	pages.GET("/apikeys", r.pageAPIKeys)
	pages.POST("/apikeys", r.handleAPIKeyCreate)
	pages.GET("/apikeys/revealed", r.pageAPIKeyRevealed)
	pages.POST("/apikeys/:key_id/revoke", r.handleAPIKeyRevoke)

	// Self-service password change (any logged-in console user; the admin
	// user-management page remains the override path for other accounts).
	pages.GET("/password", r.pagePasswordSelf)
	pages.POST("/password", r.handlePasswordSelf)
}

// ── login / logout (form flow) ──────────────────────────────────────

func loginPageHandler(auth *webuiAuthenticator) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Already authenticated: nothing to do here.
		if _, ok := auth.authenticate(auth.extractToken(c)); ok {
			c.Redirect(http.StatusFound, "/console")
			return
		}
		renderPage(c.Writer, "login", gin.H{"Error": c.Query("err"), "Username": ""})
	}
}

func loginSubmitHandler(auth *webuiAuthenticator) gin.HandlerFunc {
	return func(c *gin.Context) {
		username := strings.TrimSpace(c.PostForm("username"))
		password := c.PostForm("password")
		ip := c.ClientIP()
		if !auth.allow(ip) {
			auth.throttleAbort(c)
			return
		}
		sess, ok := auth.verifyUser(username, password)
		if !ok {
			auth.fail(ip)
			renderPage(c.Writer, "login", gin.H{
				"Error":    "用户名或密码不正确",
				"Username": username,
			})
			return
		}
		auth.reset(ip)
		sid, err := auth.newSession(sess)
		if err != nil {
			slog.Error("[PAGE] issue session failed", "err", err)
			http.Error(c.Writer, "internal error", http.StatusInternalServerError)
			return
		}
		http.SetCookie(c.Writer, &http.Cookie{
			Name:     webuiSessionCookie,
			Value:    sid,
			Path:     "/",
			MaxAge:   int(auth.ttl.Seconds()),
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
			Secure:   c.Request.TLS != nil || c.GetHeader("X-Forwarded-Proto") == "https",
		})
		slog.Info("[AUTH] console login", "username", sess.Username, "ip", ip)
		c.Redirect(http.StatusSeeOther, "/console")
	}
}

func logoutSubmitHandler(auth *webuiAuthenticator) gin.HandlerFunc {
	return func(c *gin.Context) {
		if tok := auth.extractToken(c); tok != "" {
			auth.sessions.delete(tok)
		}
		http.SetCookie(c.Writer, &http.Cookie{
			Name:     webuiSessionCookie,
			Value:    "",
			Path:     "/",
			MaxAge:   -1,
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
		})
		c.Redirect(http.StatusSeeOther, "/login")
	}
}

// pageGate redirects unauthenticated page requests to /login BEFORE any HTML
// is sent, and stashes the identity for handlers (JSON middleware's 302 twin).
func (a *webuiAuthenticator) pageGate() gin.HandlerFunc {
	return func(c *gin.Context) {
		sess, ok := a.authenticate(a.extractToken(c))
		if !ok {
			c.Redirect(http.StatusFound, "/login")
			c.Abort()
			return
		}
		c.Set(webuiCtxUser, sess)
		c.Next()
	}
}

// noHTMLFS hides *.html from the public /assets static route: pages are only
// served through the gated handlers above.
type noHTMLFS struct{ fs.FS }

func (n noHTMLFS) Open(name string) (fs.File, error) {
	if strings.HasSuffix(name, ".html") {
		return nil, fs.ErrNotExist
	}
	return n.FS.Open(name)
}

// render404 renders the shell with an error flash (keeps nav usable).
func render404(c *gin.Context, msg string) {
	c.Writer.WriteHeader(http.StatusNotFound)
	b := newBase(c, "", "未找到", "")
	b.Flash = &flashData{Kind: "err", Msg: msg}
	renderPage(c.Writer, "base", b)
}
