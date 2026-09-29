// app-task entrypoint — thin shim over the `at` CLI (internal/cli).
// One binary, two roles: no args (or `at serve`) runs the server; any other
// command is the client. Run from project root: go run ./app-task [command]
package main

import (
	_ "embed"       // embed default.yaml via //go:embed below
	_ "time/tzdata" // embed IANA tz database so Asia/Shanghai works in distroless

	"app-task/internal/cli"
)

//go:embed default.yaml
var defaultYAML []byte

func main() {
	cli.Execute(defaultYAML)
}
