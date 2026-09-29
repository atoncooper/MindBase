package cli

// Platform commands: `at info` (docker info-style overview), `at logs`
// (recent task_log entries across tasks), `at email ls|retry` (mail queue).

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

// nodeIDRe mirrors the server-side cluster join validation (router package).
var nodeIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$`)

func newInfoCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "info",
		Short: "服务信息与运行统计（对应 docker info）",
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}
			var info struct {
				Service string `json:"service"`
				Version string `json:"version"`
				Status  string `json:"status"`
				User    struct {
					Username string `json:"username"`
					Role     string `json:"role"`
				} `json:"user"`
			}
			if err := c.get("/api/info", &info); err != nil {
				return err
			}
			var stats struct {
				Service struct {
					Version string `json:"version"`
					Status  string `json:"status"`
				} `json:"service"`
				Tasks     map[string]any `json:"tasks"`
				Logs      int64          `json:"logs_total"`
				Emails    map[string]any `json:"emails"`
				Scripts   int64          `json:"scripts"`
				Now       string         `json:"now"`
				Scheduler *struct {
					Workers  int `json:"workers"`
					Inflight int `json:"inflight"`
				} `json:"scheduler"`
			}
			if err := c.get("/api/stats", &stats); err != nil {
				return err
			}
			o := cmd.OutOrStdout()
			fmt.Fprintf(o, "Service:   %s (%s)\n", info.Service, info.Status)
			fmt.Fprintf(o, "Version:   %s\n", stats.Service.Version)
			if info.User.Username != "" {
				fmt.Fprintf(o, "Identity:  %s (%s)\n", info.User.Username, info.User.Role)
			}
			fmt.Fprintf(o, "Tasks:     %v\n", stats.Tasks)
			fmt.Fprintf(o, "Logs:      %d\n", stats.Logs)
			fmt.Fprintf(o, "Emails:    %v\n", stats.Emails)
			fmt.Fprintf(o, "Scripts:   %d\n", stats.Scripts)
			if stats.Scheduler != nil {
				fmt.Fprintf(o, "Scheduler: workers %d, inflight %d\n", stats.Scheduler.Workers, stats.Scheduler.Inflight)
			}
			fmt.Fprintf(o, "Now:       %s\n", stats.Now)
			return nil
		},
	}
}

func newNodeCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "node",
		Short: "集群节点（ls）",
	}
	cmd.AddCommand(newNodeJoinCmd(), &cobra.Command{
		Use:   "ls",
		Short: "集群节点名册（存活状态 + 在飞认领数）",
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}
			var out struct {
				Nodes []struct {
					NodeID        string `json:"node_id"`
					Hostname      string `json:"hostname"`
					Version       string `json:"version"`
					Weight        int    `json:"weight"`
					State         string `json:"state"`
					StartedAt     string `json:"started_at"`
					LastHeartbeat string `json:"last_heartbeat"`
					Alive         bool   `json:"alive"`
					Claims        int64  `json:"claims"`
					Self          bool   `json:"self"`
				} `json:"nodes"`
			}
			if err := c.get("/api/cluster", &out); err != nil {
				return err
			}
			if flagJSONOut {
				return printJSON(cmd, out.Nodes)
			}
			w := tabwriter.NewWriter(cmd.OutOrStdout(), 2, 4, 2, ' ', 0)
			fmt.Fprintln(w, "NODE ID\t主机\t版本\t权重\t启动时间\t最近心跳\t认领中\t状态")
			for _, n := range out.Nodes {
				status := "存活"
				if n.State == "pending_join" {
					status = "待接入"
				} else if !n.Alive {
					status = "失联"
				}
				label := ""
				if n.Self {
					label = " (本机)"
				}
				fmt.Fprintf(w, "%s%s\t%s\t%s\t%d\t%s\t%s\t%d\t%s\n",
					n.NodeID, label, strOrDash(n.Hostname), n.Version, n.Weight,
					fmtTimeRFC(n.StartedAt), fmtTimeRFC(n.LastHeartbeat), n.Claims, status)
			}
			return w.Flush()
		},
	})
	return cmd
}

// newNodeJoinCmd pre-registers a node through the manager's join API and
// prints the onboarding instructions (the DB DSN is never echoed — fetch it
// from the secret-distribution channel).
func newNodeJoinCmd() *cobra.Command {
	var (
		name     string
		weight   int
		hostname string
	)
	cmd := &cobra.Command{
		Use:   "join",
		Short: "预登记一个新节点并生成加入指引（需 admin 凭据）",
		Example: `  at node join --name worker-3 --weight 4
  at node join --name manager --weight 1`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if !nodeIDRe.MatchString(name) {
				return fmt.Errorf("--name 需 2-64 字符，仅限字母/数字/点/下划线/连字符，字母或数字开头")
			}
			c, err := newClient()
			if err != nil {
				return err
			}
			body := map[string]any{
				"node_id":  name,
				"weight":   weight,
				"hostname": hostname,
				"via":      "cli",
			}
			var resp struct {
				NodeID       string `json:"node_id"`
				Weight       int    `json:"weight"`
				State        string `json:"state"`
				Created      bool   `json:"created"`
				InvitedBy    string `json:"invited_by"`
				Instructions string `json:"instructions"`
				ExpiresHint  string `json:"expires_hint"`
			}
			if err := c.post("/api/cluster/join", body, &resp); err != nil {
				return err
			}
			o := cmd.OutOrStdout()
			fmt.Fprintf(o, "node: %s (weight %d, state %s)\n\n", resp.NodeID, resp.Weight, resp.State)
			fmt.Fprintln(o, resp.Instructions)
			fmt.Fprintf(o, "\n提示：%s\n", resp.ExpiresHint)
			return nil
		},
	}
	cmd.Flags().StringVar(&name, "name", "", "新节点 node_id（2–64 字符，将成为 task.owner）")
	cmd.Flags().IntVar(&weight, "weight", 1, "派发权重（worker 建议高于 manager）")
	cmd.Flags().StringVar(&hostname, "hostname", "", "主机名（可选，便于溯源）")
	_ = cmd.MarkFlagRequired("name")
	return cmd
}

func newLogsCmd() *cobra.Command {
	var (
		taskID string
		limit  int
	)
	cmd := &cobra.Command{
		Use:   "logs",
		Short: "全局最近执行日志（task_log，可按 task_id 过滤）",
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}
			var out struct {
				Logs []apiTaskLog `json:"logs"`
			}
			path := fmt.Sprintf("/api/logs?limit=%d", limit)
			if taskID != "" {
				path += "&task_id=" + taskID
			}
			if err := c.get(path, &out); err != nil {
				return err
			}
			if flagJSONOut {
				return printJSON(cmd, out.Logs)
			}
			w := tabwriter.NewWriter(cmd.OutOrStdout(), 2, 4, 2, ' ', 0)
			fmt.Fprintln(w, "触发时间\tTASK ID\t执行器\t状态\t耗时\t响应/错误")
			for _, l := range out.Logs {
				line := l.Response
				if l.Error != nil && *l.Error != "" {
					line = *l.Error
				}
				fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%dms\t%s\n",
					fmtTimeRFC(l.TriggerAt), l.TaskID, strOrDash(l.Executor), l.Status,
					l.DurationMS, truncStr(line, 100))
			}
			return w.Flush()
		},
	}
	cmd.Flags().StringVar(&taskID, "task-id", "", "按 task_id 过滤")
	cmd.Flags().IntVar(&limit, "limit", 50, "返回条数")
	cmd.Flags().BoolVar(&flagJSONOut, "json", false, "以 JSON 输出")
	return cmd
}

func newEmailCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "email",
		Short: "邮件队列（ls / retry）",
	}
	cmd.AddCommand(newEmailLsCmd(), newEmailRetryCmd())
	return cmd
}

func newEmailLsCmd() *cobra.Command {
	var (
		status string
		limit  int
	)
	cmd := &cobra.Command{
		Use:   "ls",
		Short: "邮件队列列表",
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}
			var out struct {
				Total  int64 `json:"total"`
				Emails []struct {
					EmailID    string   `json:"email_id"`
					To         []string `json:"to"`
					Subject    string   `json:"subject"`
					Status     string   `json:"status"`
					RetryCount int      `json:"retry_count"`
					CreatedAt  string   `json:"created_at"`
					SentAt     *string  `json:"sent_at"`
				} `json:"emails"`
			}
			path := fmt.Sprintf("/api/emails?limit=%d", limit)
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
			fmt.Fprintln(w, "EMAIL ID\t收件人\t主题\t状态\t重试\t创建时间")
			for _, e := range out.Emails {
				fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%d\t%s\n",
					e.EmailID, strings.Join(e.To, ","), truncStr(e.Subject, 40),
					e.Status, e.RetryCount, fmtTimeRFC(e.CreatedAt))
			}
			fmt.Fprintf(w, "—— 共 %d 条\n", out.Total)
			return w.Flush()
		},
	}
	cmd.Flags().StringVar(&status, "status", "", "按状态过滤（pending/sent/failed/dry_run）")
	cmd.Flags().IntVar(&limit, "limit", 50, "返回条数")
	cmd.Flags().BoolVar(&flagJSONOut, "json", false, "以 JSON 输出")
	return cmd
}

func newEmailRetryCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "retry <email_id>",
		Short: "失败邮件重新入队",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}
			var resp struct {
				EmailID string `json:"email_id"`
				Status  string `json:"status"`
			}
			if err := c.post("/api/emails/"+args[0]+"/retry", nil, &resp); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%s -> %s\n", resp.EmailID, resp.Status)
			return nil
		},
	}
}

// printJSON renders v as indented, HTML-escaped-off JSON (docker inspect style).
func printJSON(cmd *cobra.Command, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	fmt.Fprintln(cmd.OutOrStdout(), string(b))
	return nil
}

func strOf(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func intOf(v any) int64 {
	if n, ok := v.(float64); ok {
		return int64(n)
	}
	return 0
}

func truncStr(s string, n int) string {
	if s == "" {
		return "—"
	}
	r := []rune(s)
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}
