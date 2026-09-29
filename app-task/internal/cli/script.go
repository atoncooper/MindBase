package cli

// Script commands: `at script ls|upload|inspect|run` — full Lua script
// lifecycle against the /api/scripts surface + the /internal/script/run
// endpoint (both accept console credentials).

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

type apiScript struct {
	ScriptID    string `json:"script_id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Version     int    `json:"version"`
	Enabled     bool   `json:"enabled"`
	UpdatedAt   string `json:"updated_at"`
}

func newScriptCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "script",
		Short: "Lua 脚本管理（ls / upload / inspect / run）",
	}
	cmd.AddCommand(newScriptLsCmd(), newScriptUploadCmd(), newScriptInspectCmd(), newScriptRunCmd())
	return cmd
}

func newScriptLsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "ls",
		Aliases: []string{"list"},
		Short:   "脚本列表（最新版本）",
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}
			var out struct {
				Scripts []apiScript `json:"scripts"`
			}
			if err := c.get("/api/scripts", &out); err != nil {
				return err
			}
			if flagJSONOut {
				return printJSON(cmd, out.Scripts)
			}
			w := tabwriter.NewWriter(cmd.OutOrStdout(), 2, 4, 2, ' ', 0)
			fmt.Fprintln(w, "SCRIPT ID\t名称\t版本\t启用\t更新时间")
			for _, s := range out.Scripts {
				enabled := "停用"
				if s.Enabled {
					enabled = "启用"
				}
				fmt.Fprintf(w, "%s\t%s\tv%d\t%s\t%s\n",
					s.ScriptID, s.Name, s.Version, enabled, fmtTimeRFC(s.UpdatedAt))
			}
			fmt.Fprintf(w, "—— 共 %d 个\n", len(out.Scripts))
			return w.Flush()
		},
	}
	cmd.Flags().BoolVar(&flagJSONOut, "json", false, "以 JSON 输出")
	return cmd
}

func newScriptUploadCmd() *cobra.Command {
	var (
		file        string
		name        string
		description string
		scriptID    string
		disable     bool
	)
	cmd := &cobra.Command{
		Use:   "upload --file <script.lua>",
		Short: "上传/更新脚本（保存即新版本；省略 --id 时系统生成 script_id）",
		RunE: func(cmd *cobra.Command, args []string) error {
			if file == "" {
				return fmt.Errorf("--file 必填（Lua 源码文件）")
			}
			source, err := os.ReadFile(file)
			if err != nil {
				return err
			}
			if name == "" {
				name = strings.TrimSuffix(filepath.Base(file), filepath.Ext(file))
			}
			body := map[string]any{
				"name":        name,
				"description": description,
				"source":      string(source),
				"enabled":     !disable,
			}
			if scriptID != "" {
				body["script_id"] = scriptID
			}
			c, err := newClient()
			if err != nil {
				return err
			}
			var resp struct {
				ScriptID string `json:"script_id"`
				Version  int    `json:"version"`
				Status   string `json:"status"`
			}
			if err := c.post("/api/scripts", body, &resp); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%s (v%d)\n", resp.ScriptID, resp.Version)
			return nil
		},
	}
	cmd.Flags().StringVar(&file, "file", "", "Lua 源码文件路径")
	cmd.Flags().StringVar(&name, "name", "", "脚本名称（默认取文件名去扩展名）")
	cmd.Flags().StringVar(&description, "description", "", "描述")
	cmd.Flags().StringVar(&scriptID, "id", "", "更新已有脚本时传其 script_id（省略 = 新建并自动生成 UUID）")
	cmd.Flags().BoolVar(&disable, "disable", false, "上传为停用状态（默认启用）")
	return cmd
}

func newScriptInspectCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "inspect <script_id>",
		Short: "脚本详情（源码 + 版本历史 + 审计日志，JSON）",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}
			var out map[string]any
			if err := c.get("/api/scripts/"+args[0], &out); err != nil {
				return err
			}
			return printJSON(cmd, out)
		},
	}
}

func newScriptRunCmd() *cobra.Command {
	var payload string
	cmd := &cobra.Command{
		Use:   "run <script_id>",
		Short: "立即执行一次脚本（同步返回结果，落 script_run 可回溯）",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			payloadBytes, err := loadPayloadArg(payload)
			if err != nil {
				return err
			}
			body := map[string]any{
				"script_id": args[0],
				"payload":   json.RawMessage(payloadBytes),
			}
			c, err := newClient()
			if err != nil {
				return err
			}
			var resp struct {
				RunID      string   `json:"run_id"`
				ScriptID   string   `json:"script_id"`
				Version    int      `json:"version"`
				Status     string   `json:"status"`
				Error      *string  `json:"error"`
				Logs       []string `json:"logs"`
				DurationMS int64    `json:"duration_ms"`
			}
			if err := c.post("/internal/script/run", body, &resp); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "status=%s run_id=%s duration=%dms\n",
				resp.Status, resp.RunID, resp.DurationMS)
			for _, l := range resp.Logs {
				if strings.TrimSpace(l) != "" {
					fmt.Fprintln(cmd.OutOrStdout(), "  "+l)
				}
			}
			if resp.Error != nil && *resp.Error != "" {
				fmt.Fprintln(cmd.OutOrStdout(), "  error: "+*resp.Error)
			}
			if resp.Status != "success" {
				return fmt.Errorf("script run failed (%s)", resp.Status)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&payload, "payload", "", "payload（内联 JSON、@file 或 -；默认 {}）")
	return cmd
}
