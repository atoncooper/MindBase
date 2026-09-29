// Package cli implements the `at` command line interface (docker-style:
// <noun> <verb> [flags]). One binary, two roles:
//
//	at            (no args)  start the server — backward compatible with the
//	                         old `go run ./app-task` entrypoint
//	at serve                 explicit server mode
//	at <noun> <verb> ...     client mode: talks to a running app-task over
//	                         the /api/* surface with the master token
//	                         (X-WebUI-Token) or a service API key (X-API-Key)
package cli

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"app-task/internal/router"
)

// Global flag values (bound in Execute, read by the client commands).
var (
	flagURL   string
	flagToken string
)

// Execute runs the root command. defaultYAML is the embedded server config
// (passed through to the serve command).
func Execute(defaultYAML []byte) {
	if err := newRootCmd(defaultYAML).Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "at:", err)
		os.Exit(1)
	}
}

func newRootCmd(defaultYAML []byte) *cobra.Command {
	root := &cobra.Command{
		Use:   "at",
		Short: "MindBase 任务调度平台 CLI（app-task）",
		Long: `at — MindBase 任务调度平台命令行（app-task）

无参数启动服务端（调度器 + API + 控制台，等价 at serve）；
其余命令为客户端，通过 HTTP API 操作运行中的 app-task。

认证：master token（控制台 webui.token / env APPTASK__WEBUI__TOKEN）
或服务面 API 密钥（at_ 前缀，控制台「API 密钥」页生成）。
env：AT_URL（API 地址）、AT_TOKEN（凭据）。`,
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       router.Version,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runServer(defaultYAML) // bare `at` = serve
		},
	}
	root.SetOut(os.Stdout)
	root.SetErr(os.Stderr)
	root.CompletionOptions.DisableDefaultCmd = true
	root.PersistentFlags().StringVar(&flagURL, "url", "",
		"app-task API 地址（默认 http://127.0.0.1:8001；env AT_URL）")
	root.PersistentFlags().StringVar(&flagToken, "token", "",
		"API 凭据：master token 或服务面密钥（env AT_TOKEN / APPTASK__WEBUI__TOKEN）")

	root.AddCommand(
		newServeCmd(defaultYAML),
		newInfoCmd(),
		newPSCommand(),
		newTaskCmd(),
		newScriptCmd(),
		newNodeCmd(),
		newLogsCmd(),
		newEmailCmd(),
	)

	return root
}
