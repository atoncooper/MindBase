package cli

// Task commands: `at task ls|create|inspect|logs` (+ top-level `at ps` alias,
// mirroring `docker ps`).

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
)

// flagJSONOut backs the per-command --json flag (only one command runs per
// invocation, so sharing the variable across list commands is safe).
var flagJSONOut bool

type apiTask struct {
	TaskID      string          `json:"task_id"`
	UID         int64           `json:"uid"`
	TaskType    string          `json:"task_type"`
	Status      string          `json:"status"`
	Owner       string          `json:"owner"`
	TriggerTime string          `json:"trigger_time"`
	ExecutorURL string          `json:"executor_url"`
	Async       bool            `json:"async"`
	CronExpr    string          `json:"cron_expr"`
	MaxRetry    int             `json:"max_retry"`
	RetryCount  int             `json:"retry_count"`
	LastResult  *string         `json:"last_result"`
	Weight      int             `json:"weight"`
	Payload     json.RawMessage `json:"payload"`
	CreatedAt   string          `json:"created_at"`
	UpdatedAt   string          `json:"updated_at"`
}

type apiTaskLog struct {
	LogID      string  `json:"log_id"`
	TaskID     string  `json:"task_id"`
	TriggerAt  string  `json:"trigger_at"`
	Executor   string  `json:"executor"`
	Status     string  `json:"status"`
	DurationMS int64   `json:"duration_ms"`
	Response   string  `json:"response"`
	Error      *string `json:"error"`
}

func fmtTimeRFC(s string) string {
	if s == "" {
		return "—"
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return s
	}
	return t.Local().Format("2006-01-02 15:04:05")
}

func strOrDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "—"
	}
	return s
}

func newPSCommand() *cobra.Command {
	cmd := newTaskLsCmd()
	cmd.Use = "ps"
	cmd.Short = "任务列表（at task ls 的别名，对应 docker ps）"
	return cmd
}

func newTaskCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "task",
		Short: "任务管理（ls / create / inspect / logs）",
	}
	cmd.AddCommand(newTaskLsCmd(), newTaskCreateCmd(), newTaskInspectCmd(), newTaskLogsCmd())
	return cmd
}

func newTaskLsCmd() *cobra.Command {
	var status string
	var limit int
	cmd := &cobra.Command{
		Use:     "ls",
		Aliases: []string{"list"},
		Short:   "任务列表",
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}
			var out struct {
				Total int64     `json:"total"`
				Tasks []apiTask `json:"tasks"`
			}
			path := fmt.Sprintf("/api/tasks?limit=%d", limit)
			if status != "" {
				path += "&status=" + status
			}
			if err := c.get(path, &out); err != nil {
				return err
			}
			if flagJSONOut {
				return printJSON(cmd, out)
			}
			w := tabwriter.NewWriter(cmd.OutOrStdout(), 2, 4, 2, ' ', 0)
			fmt.Fprintln(w, "TASK ID\t类型\t状态\t属主\t触发时间\t执行器\t重试")
			for _, t := range out.Tasks {
				fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%d/%d\n",
					t.TaskID, t.TaskType, t.Status, strOrDash(t.Owner),
					fmtTimeRFC(t.TriggerTime), strOrDash(t.ExecutorURL), t.RetryCount, t.MaxRetry)
			}
			fmt.Fprintf(w, "—— 共 %d 条\n", out.Total)
			return w.Flush()
		},
	}
	cmd.Flags().StringVar(&status, "status", "", "按状态过滤（pending/dispatching/running/completed/failed）")
	cmd.Flags().IntVar(&limit, "limit", 50, "返回条数")
	cmd.Flags().BoolVar(&flagJSONOut, "json", false, "以 JSON 输出")
	return cmd
}

func newTaskCreateCmd() *cobra.Command {
	var (
		taskType    string
		executorURL string
		triggerTime string
		cronExpr    string
		payload     string
		scriptID    string
		async       bool
		maxRetry    int
		weight      int
		uid         int64
	)
	cmd := &cobra.Command{
		Use:   "create",
		Short: "注册任务（属主 uid 默认自动归属当前凭据）",
		Example: `  # 一次性 HTTP 任务
  at task create --executor-url https://exec:9000/run --trigger-time "2026-10-01 09:00:00" --payload '{"a":1}'

  # 周期 lua 任务
  at task create --type lua --script-id <uuid> --cron "0 23 * * *"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if taskType != "http" && taskType != "lua" {
				return fmt.Errorf("--type 必须是 http 或 lua")
			}
			if cronExpr == "" && triggerTime == "" {
				return fmt.Errorf("--cron 与 --trigger-time 至少填一个")
			}
			payloadBytes, err := loadPayloadArg(payload)
			if err != nil {
				return err
			}
			obj := map[string]any{}
			if len(payloadBytes) > 0 {
				if err := json.Unmarshal(payloadBytes, &obj); err != nil {
					return fmt.Errorf("--payload 不是合法 JSON：%v", err)
				}
			}
			if scriptID != "" {
				if taskType != "lua" {
					return fmt.Errorf("--script-id 仅用于 --type lua")
				}
				obj["script_id"] = scriptID
			}
			var payloadOut json.RawMessage
			if len(obj) > 0 {
				payloadOut, err = json.Marshal(obj)
				if err != nil {
					return err
				}
			}
			var triggerOut string
			if triggerTime != "" {
				t, err := parseTimeArg(triggerTime)
				if err != nil {
					return err
				}
				triggerOut = t.UTC().Format(time.RFC3339)
			}
			body := map[string]any{
				"task_type":    taskType,
				"executor_url": executorURL,
				"async":        async,
				"cron_expr":    cronExpr,
				"trigger_time": triggerOut,
				"max_retry":    maxRetry,
				"weight":       weight,
			}
			if len(payloadOut) > 0 {
				body["payload"] = payloadOut
			}
			if cmd.Flags().Changed("uid") {
				body["uid"] = uid
			}
			c, err := newClient()
			if err != nil {
				return err
			}
			var resp struct {
				TaskID string `json:"task_id"`
				Status string `json:"status"`
			}
			if err := c.post("/api/tasks", body, &resp); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%s\n", resp.TaskID)
			return nil
		},
	}
	cmd.Flags().StringVar(&taskType, "type", "http", "任务类型：http | lua")
	cmd.Flags().StringVar(&executorURL, "executor-url", "", "http 类型必填：第三方执行器端点")
	cmd.Flags().StringVar(&triggerTime, "trigger-time", "", "一次性触发时间（RFC3339 或 \"2006-01-02 15:04:05\" 本地时区）")
	cmd.Flags().StringVar(&cronExpr, "cron", "", "5 段 cron（留空 = 一次性）")
	cmd.Flags().StringVar(&payload, "payload", "", "JSON 透传给执行器：内联 JSON、@file.json 或 -（stdin）")
	cmd.Flags().StringVar(&scriptID, "script-id", "", "lua 任务：自动写入 payload.script_id")
	cmd.Flags().BoolVar(&async, "async", false, "异步（执行器 202 + 回调）")
	cmd.Flags().IntVar(&maxRetry, "max-retry", 0, "失败重试次数")
	cmd.Flags().IntVar(&weight, "weight", 1, "WFQ 权重（预留）")
	cmd.Flags().Int64Var(&uid, "uid", 0, "显式属主 uid（默认自动 = 当前凭据）")
	return cmd
}

func newTaskInspectCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "inspect <task_id>",
		Short: "任务详情 + 最近执行日志（JSON）",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}
			var out struct {
				Task map[string]any   `json:"task"`
				Logs []map[string]any `json:"logs"`
			}
			if err := c.get("/api/tasks/"+args[0], &out); err != nil {
				return err
			}
			return printJSON(cmd, out)
		},
	}
}

func newTaskLogsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "logs <task_id>",
		Short: "某任务的执行日志（task_log）",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}
			var out struct {
				Task map[string]any   `json:"task"`
				Logs []map[string]any `json:"logs"`
			}
			if err := c.get("/api/tasks/"+args[0], &out); err != nil {
				return err
			}
			if flagJSONOut {
				return printJSON(cmd, out.Logs)
			}
			w := tabwriter.NewWriter(cmd.OutOrStdout(), 2, 4, 2, ' ', 0)
			fmt.Fprintln(w, "触发时间\t执行器\t状态\t耗时\t响应/错误")
			for _, l := range out.Logs {
				resp := strOf(l["response"])
				errS := strOf(l["error"])
				line := resp
				if errS != "" {
					line = errS
				}
				fmt.Fprintf(w, "%s\t%s\t%s\t%dms\t%s\n",
					fmtTimeRFC(strOf(l["trigger_at"])), strOf(l["executor"]), strOf(l["status"]),
					intOf(l["duration_ms"]), truncStr(line, 120))
			}
			return w.Flush()
		},
	}
	cmd.Flags().BoolVar(&flagJSONOut, "json", false, "以 JSON 输出")
	return cmd
}

// loadPayloadArg parses a --payload value: inline JSON, @file, or - (stdin).
func loadPayloadArg(v string) ([]byte, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil, nil
	}
	if v == "-" {
		return io.ReadAll(os.Stdin)
	}
	if strings.HasPrefix(v, "@") {
		return os.ReadFile(strings.TrimPrefix(v, "@"))
	}
	return []byte(v), nil
}

// parseTimeArg accepts RFC3339 and common local-time layouts.
func parseTimeArg(v string) (time.Time, error) {
	for _, layout := range []string{
		time.RFC3339, "2006-01-02 15:04:05", "2006-01-02T15:04", "2006-01-02 15:04",
	} {
		if t, err := time.ParseInLocation(layout, v, time.Local); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("无法解析时间 %q（期望 RFC3339 或 \"2006-01-02 15:04:05\"）", v)
}
